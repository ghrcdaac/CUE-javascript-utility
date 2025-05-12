import { calculateSHA256Checksum, calculateSHA256ChecksumForBytes, getMimeType, formatBytes, isFileTypeDisallowed } from './utils.js';
import fsPromises from 'fs/promises'; // For UploadPartTaskJS
import path from 'path'; // For path.basename

const S3_MAX_PARTS_JS_MPU = 10000; // Renamed to avoid conflict

class UploadPartTaskJS_MPU { // Renamed to avoid conflict
    constructor(partNumber, offset, size, filePath) {
        this.partNumber = partNumber; this.offset = offset; this.size = size; this.filePath = filePath;
        this.data = null; this.checksumSHA256 = null; this.etag = null; this.error = null; this.retries = 0;
    }
    async readAndChecksum() {
        try {
            const fileHandle = await fsPromises.open(this.filePath, 'r');
            const buffer = Buffer.alloc(this.size);
            const { bytesRead } = await fileHandle.read(buffer, 0, this.size, this.offset);
            await fileHandle.close();
            if (bytesRead !== this.size) throw new Error(`Read incorrect data size for part ${this.partNumber}`);
            this.data = buffer.subarray(0, bytesRead);
            this.checksumSHA256 = calculateSHA256ChecksumForBytes(this.data);
        } catch (e) {
            this.error = new Error(`Error reading/checksumming part ${this.partNumber}: ${e.message}`);
            console.error(`[CUE Upload Lib] ${this.error.message}`); throw this.error;
        }
    }
}

async function _uploadSinglePartWithRetryJS_MPU( // Renamed
    partTask, apiClient, config, s3UploadId, backendS3Key,
    collection, originalFileMimeType, onPartProgress
) {
    if (!partTask.data || !partTask.checksumSHA256) await partTask.readAndChecksum();
    if (partTask.error) throw partTask.error;

    const partDesc = `Part ${String(partTask.partNumber).padStart(4)} (${formatBytes(partTask.size)})`;

    for (let attempt = 0; attempt <= config.retry_attempts; attempt++) {
        partTask.retries = attempt;
        try {
            if (onPartProgress) onPartProgress(partTask.partNumber, 0, partTask.size, `Req URL ${attempt + 1}`);
            const getUrlPayload = {
                upload_id: s3UploadId, part_number: partTask.partNumber, file_name: backendS3Key,
                collection, checksum: partTask.checksumSHA256, content_type: originalFileMimeType
            };
            const presignedPartInfo = await apiClient.getPresignedUrlForPart(getUrlPayload);

            if (onPartProgress) onPartProgress(partTask.partNumber, 0, partTask.size, `Uploading ${attempt + 1}`);
            const s3Response = await apiClient.uploadPartToS3PresignedPut(presignedPartInfo.presigned_url, partTask.data);
            
            const etag = s3Response.headers.get ? s3Response.headers.get("etag")?.replace(/"/g, "") : s3Response.headers["etag"]?.replace(/"/g, "");
            if (!etag) throw new Error("ETag not found for part.");
            partTask.etag = etag;

            if (onPartProgress) onPartProgress(partTask.partNumber, partTask.size, partTask.size, "Done");
            return { PartNumber: partTask.partNumber, ETag: partTask.etag, ChecksumSHA256: partTask.checksumSHA256 };
        } catch (error) {
            console.warn(`[CUE Upload Lib] ${partDesc} Attempt ${attempt + 1} failed: ${error.message.substring(0,100)}`);
            if (onPartProgress) onPartProgress(partTask.partNumber, 0, partTask.size, `Retry ${attempt + 1}`);
            if (attempt >= config.retry_attempts) {
                partTask.error = error;
                if (onPartProgress) onPartProgress(partTask.partNumber, 0, partTask.size, "Failed");
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, (2 ** attempt) * 1000));
        }
    }
    return null;
}

export async function handleMultipartUpload(
    filePath, fileSize, collection, targetSubPath,
    apiClient, config, // globalArgs removed
    partConcurrency, options = {}
) {
    const { onProgress, onPartProgress } = options;
    const baseName = path.basename(filePath);
    const logPrefix = "[CUE Upload Lib]";
    const notifyProgress = (message, type = "info", details = {}) => {
        if (onProgress) onProgress({ file: baseName, message, type, ...details, phase: "multipart" });
        else console.log(`${logPrefix} ${type.toUpperCase()}: ${message}`);
    };

    notifyProgress(`Preparing multipart upload for: ${baseName} (${formatBytes(fileSize)})`);
    if (isFileTypeDisallowed(filePath)) throw new Error(`Disallowed file type: ${path.extname(filePath)}`);

    let chunkSize = config.multipart_chunk_size_mb * 1024 * 1024;
    if (chunkSize < 5 * 1024 * 1024) chunkSize = 5 * 1024 * 1024;
    const numParts = Math.ceil(fileSize / chunkSize);
    if (numParts > S3_MAX_PARTS_JS_MPU) throw new Error(`File requires ${numParts} parts, exceeding S3 limit.`);

    const mimeType = getMimeType(filePath);
    notifyProgress(`Calculating overall SHA256 for ${baseName}...`);
    const overallChecksum = await calculateSHA256Checksum(filePath);
    notifyProgress(`Overall SHA256: ${overallChecksum}`, "debug");

    const startPayload = {
        file_name: baseName, collection, upload_target: targetSubPath,
        content_type: mimeType, overall_checksum: overallChecksum
    };
    let s3UploadId, backendS3Key;
    try {
        notifyProgress(`Initiating multipart upload with backend for ${baseName}...`);
        const startResponse = await apiClient.startMultipartUpload(startPayload);
        s3UploadId = startResponse.upload_id; backendS3Key = startResponse.s3_key;
        if (!s3UploadId || !backendS3Key) throw new Error("Backend MPU start error.");
        notifyProgress(`Multipart initiated. Upload ID: ${s3UploadId}, S3 Key: ${backendS3Key}`);
    } catch (e) { throw new Error(`Failed to initiate MPU: ${e.message}`); }

    const partTasks = [];
    if (numParts > 0) {
        for (let i = 0; i < numParts; i++) {
            const size = Math.min(chunkSize, fileSize - (i * chunkSize));
            if (size <= 0) continue;
            partTasks.push(new UploadPartTaskJS_MPU(i + 1, i * chunkSize, size, filePath));
        }
    }
    if (partTasks.length > 0) {
        notifyProgress(`Preparing ${partTasks.length} parts...`);
        for (const pt of partTasks) {
            notifyProgress(`Preparing part ${pt.partNumber}...`, "debug");
            await pt.readAndChecksum();
            if (pt.error) throw new Error(`Failed to prepare part ${pt.partNumber}: ${pt.error.message}`);
        }
    } else if (fileSize > 0) throw new Error("No parts for non-empty file.");

    const uploadedPartsInfo = []; let totalBytesUploadedForFile = 0;
    notifyProgress(`Uploading ${partTasks.length} parts concurrently (max ${partConcurrency})...`);
    
    const promises = [];
    for(let i=0; i < partTasks.length; i++) {
        promises.push(
            _uploadSinglePartWithRetryJS_MPU(
                partTasks[i], apiClient, config, s3UploadId, backendS3Key,
                collection, mimeType, 
                (partNum, bytesDone, totalPartSize, statusMsg) => { // onPartProgress callback
                    // This simple version doesn't track individual part progress bytes for overall.
                    // It updates overall when a part is DONE.
                    if (statusMsg === "Done") {
                        totalBytesUploadedForFile += totalPartSize;
                         if (onProgress) onProgress({file: baseName, loaded: totalBytesUploadedForFile, total: fileSize, phase: "part_upload"});
                         else process.stdout.write(`\r${logPrefix} Overall Upload Progress: ${(fileSize > 0 ? (totalBytesUploadedForFile / fileSize * 100).toFixed(1) : 100)}% `);
                    }
                    // console.log(`${logPrefix} Part ${partNum}: ${statusMsg} (${formatBytes(bytesDone)} / ${formatBytes(totalPartSize)})`);
                }
            )
        );
    }
    const results = await Promise.allSettled(promises);
    results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            uploadedPartsInfo.push(result.value);
        }
    });
    if (fileSize > 0) process.stdout.write('\n');


    if (partTasks.length > 0 && uploadedPartsInfo.length !== partTasks.length) {
        const failedParts = partTasks.filter(pt => !pt.etag).map(pt => pt.partNumber);
        notifyProgress(`Not all parts uploaded. Failed: ${failedParts.join(', ')}. Aborting...`, "error");
        const abortPayload = { upload_id: s3UploadId, s3_key: backendS3Key, file_name: backendS3Key, collection };
        try { await apiClient.abortMultipartUpload(abortPayload); notifyProgress("MPU aborted with backend."); } 
        catch (abortError) { notifyProgress(`Failed to abort MPU with backend: ${abortError.message}`, "error"); }
        throw new Error(`One or more parts failed. Failed parts: ${failedParts.join(', ')}`);
    }

    uploadedPartsInfo.sort((a, b) => a.PartNumber - b.PartNumber);
    const completePayload = {
        upload_id: s3UploadId, parts: uploadedPartsInfo, s3_key: backendS3Key,
        file_name: baseName, collection, checksum: overallChecksum,
        final_file_size: fileSize, collection_path: targetSubPath, content_type: mimeType
    };

    try {
        notifyProgress(`Completing multipart upload with backend for ${baseName}...`);
        const completeResponse = await apiClient.completeMultipartUpload(completePayload);
        notifyProgress(`Successfully uploaded and completed ${baseName}. Location: ${completeResponse.Location}`, "success");
        return { file: baseName, status: "success", s3_key: backendS3Key, location: completeResponse.Location };
    } catch (error) {
        notifyProgress(`Failed to complete MPU with backend: ${error.message}. Aborting S3 MPU...`, "error");
        const abortPayload = { upload_id: s3UploadId, s3_key: backendS3Key, file_name: backendS3Key, collection };
        try { await apiClient.abortMultipartUpload(abortPayload); notifyProgress("S3 MPU aborted via backend."); } 
        catch (abortError) { notifyProgress(`Also failed to abort S3 MPU: ${abortError.message}`, "error"); }
        throw new Error(`Failed to complete MPU with backend: ${error.message}`);
    }
}