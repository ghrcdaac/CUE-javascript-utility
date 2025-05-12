import fsPromises from 'fs/promises'; // For readdir
import path from 'path';
import { getFileSize, formatBytes, isFileTypeDisallowed, isPathIgnored } from './utils.js';
// singleFileUploader and multipartUploader are imported dynamically in processFolderUpload

async function scanFolderForUpload(folderPath, rootForRelativePath, configPathOverride, ignorePatterns) {
    const filesToUpload = [];
    let totalSize = 0;
    const items = await fsPromises.readdir(folderPath, { withFileTypes: true });

    for (const item of items) {
        const itemPath = path.join(folderPath, item.name);
        if (isPathIgnored(itemPath, rootForRelativePath, ignorePatterns)) {
            // console.debug(`[CUE Upload Lib] Ignoring during scan: ${itemPath}`);
            continue;
        }
        if (item.isDirectory()) {
            const subFolderResult = await scanFolderForUpload(itemPath, rootForRelativePath, configPathOverride, ignorePatterns);
            filesToUpload.push(...subFolderResult.filesToUpload);
            totalSize += subFolderResult.totalSize;
        } else if (item.isFile()) {
            if (isFileTypeDisallowed(itemPath)) {
                console.warn(`[CUE Upload Lib] WARN: Skipping disallowed file type: ${item.name}`);
                continue;
            }
            const fileSize = await getFileSize(itemPath);
            filesToUpload.push({
                localPath: itemPath,
                relativePath: path.relative(rootForRelativePath, itemPath).replace(/\\/g, '/'),
                size: fileSize, status: "pending", errorMessage: null
            });
            totalSize += fileSize;
        }
    }
    return { filesToUpload, totalSize };
}

export async function processFolderUpload(
    rootFolderPath, collection, targetSubPath, // targetSubPath is the base for remote structure
    apiClient, config, // globalArgs removed
    fileConcurrency, partConcurrency, autoApprove, options = {} // options for progress
) {
    const { onFolderProgress, onFileProgress, onPartProgressUpdate } = options;
    const logPrefix = "[CUE Upload Lib]";
    const notifyFolderProgress = (message, type = "info", details = {}) => {
        if (onFolderProgress) onFolderProgress({ folder: rootFolderPath, message, type, ...details });
        else console.log(`${logPrefix} ${type.toUpperCase()}: ${message}`);
    };

    notifyFolderProgress(`Starting folder upload for: ${rootFolderPath}`);
    const { filesToUpload, totalSize } = await scanFolderForUpload(rootFolderPath, rootFolderPath, null, config.user_ignored_patterns);

    if (filesToUpload.length === 0) {
        notifyFolderProgress("No files found to upload (after ignores).", "warn");
        return { totalFiles: 0, successfulUploads: 0, failedUploads: 0, results: [] };
    }
    notifyFolderProgress(`Found ${filesToUpload.length} files, total size: ${formatBytes(totalSize)}.`);

    if (!autoApprove) {
        // For a library, interactive prompt is tricky. Caller should handle this.
        // We'll assume autoApprove = true or caller handles confirmation.
        console.warn(`${logPrefix} autoApprove is false, but library cannot prompt. Assuming approval.`);
    }

    let successfulUploads = 0; let failedUploads = 0;
    const activeFileUploads = new Set(); let currentIndex = 0;
    let overallUploadedBytesInFolder = 0;
    const results = [];

    const updateOverallFolderProgress = () => {
        const processedCount = successfulUploads + failedUploads;
        if (onFolderProgress) {
            onFolderProgress({
                folder: rootFolderPath, loaded: overallUploadedBytesInFolder, total: totalSize,
                filesProcessed: processedCount, totalFiles: filesToUpload.length,
                phase: "uploading_files"
            });
        } else {
             process.stdout.write(`\r${logPrefix} Folder Progress: ${processedCount}/${filesToUpload.length} files (${formatBytes(overallUploadedBytesInFolder)}/${formatBytes(totalSize)}) `);
        }
    };
    updateOverallFolderProgress();

    const { handleSingleFileUpload: singleUploadHandlerLib } = await import('./singleFileUploader.js');
    const { handleMultipartUpload: multiUploadHandlerLib } = await import('./multipartUploader.js');

    function scheduleNextFileInFolder() {
        while (activeFileUploads.size < fileConcurrency && currentIndex < filesToUpload.length) {
            const fileTask = filesToUpload[currentIndex++];
            let effectiveApiTargetSubPath = targetSubPath || "";
            if (path.dirname(fileTask.relativePath) !== '.') {
                 effectiveApiTargetSubPath = path.join(effectiveApiTargetSubPath, path.dirname(fileTask.relativePath)).replace(/\\/g, '/');
            }

            const promise = (async () => {
                try {
                    notifyFolderProgress(`Starting upload for: ${fileTask.relativePath}`, "info", { file: fileTask.relativePath});
                    const multipartThresholdBytes = config.multipart_threshold_gb * (1024 ** 3);
                    let result;
                    if (fileTask.size > multipartThresholdBytes) {
                        result = await multiUploadHandlerLib(
                            fileTask.localPath, fileTask.size, collection, effectiveApiTargetSubPath,
                            apiClient, config, partConcurrency, { onProgress: onFileProgress, onPartProgress: onPartProgressUpdate }
                        );
                    } else {
                        result = await singleUploadHandlerLib(
                            fileTask.localPath, fileTask.size, collection, effectiveApiTargetSubPath,
                            apiClient, config, { onProgress: onFileProgress }
                        );
                    }
                    fileTask.status = "success"; results.push({ ...fileTask, ...result});
                    successfulUploads++; overallUploadedBytesInFolder += fileTask.size;
                } catch (error) {
                    console.error(`\n${logPrefix} ERROR uploading ${fileTask.relativePath}: ${error.message}`);
                    fileTask.status = "failed"; fileTask.errorMessage = error.message; results.push(fileTask);
                    failedUploads++;
                } finally {
                    activeFileUploads.delete(promise);
                    updateOverallFolderProgress();
                    scheduleNextFileInFolder();
                }
            })();
            activeFileUploads.add(promise);
        }
    }
    scheduleNextFileInFolder();
    await new Promise(resolve => { // Wait for all files to be processed
        const interval = setInterval(() => {
            if (activeFileUploads.size === 0 && currentIndex === filesToUpload.length) {
                clearInterval(interval); resolve();
            }
        }, 200);
    });
    if (totalSize > 0 || filesToUpload.length > 0) process.stdout.write('\n');

    notifyFolderProgress("Folder upload process finished.", "info", {
        totalFiles: filesToUpload.length, successfulUploads, failedUploads
    });
    if (failedUploads > 0) {
        throw new Error(`${failedUploads} file(s) failed to upload during folder processing.`);
    }
    return { totalFiles: filesToUpload.length, successfulUploads, failedUploads, results };
}