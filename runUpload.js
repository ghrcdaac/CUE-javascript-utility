
import { CUEUploader } from 'cue-upload-library'; // Or 'from ./index.js' if using locally
// Make sure to import formatBytes if you use it in callbacks, or handle formatting in the calling app
// import { formatBytes } from './utils.js'; // If utils.js is in the same directory as your example

async function runUpload() {
    const uploaderOptions = {
        token: "YOUR_JWT_TOKEN_HERE", // Highest precedence
        env: "local", // Overrides default_env in config.json
        // configPath: "/custom/path/to/config.json", // Optional
        // verboseLevel: 1, // 0 for info, 1+ for debug console logs from library
        
        // Optional Progress Callbacks
        onFolderProgress: (progress) => {
            console.log(`FOLDER [${progress.folder}]: ${progress.message}`, 
                        progress.filesProcessed !== undefined ? `${progress.filesProcessed}/${progress.totalFiles} files` : '',
                        // progress.loaded !== undefined ? `(${formatBytes(progress.loaded)}/${formatBytes(progress.total)})` : '' // Requires formatBytes
                        progress.loaded !== undefined ? `(${progress.loaded} bytes / ${progress.total} bytes)` : ''
                        );
        },
        onFileProgress: (progress) => { // For single/multipart overall file progress
            console.log(`  FILE [${progress.file}]: ${progress.message}`, 
                        // progress.loaded !== undefined ? `(${formatBytes(progress.loaded)}/${formatBytes(progress.total)})` : '' // Requires formatBytes
                        progress.loaded !== undefined ? `(${progress.loaded} bytes / ${progress.total} bytes)` : ''
                        );
        },
        onPartProgress: (partNum, loaded, total, statusMsg) => { // For multipart individual part progress
            // console.log(`    PART [${partNum}]: ${statusMsg} (${formatBytes(loaded)}/${formatBytes(total)})`); // Requires formatBytes
        }
    };

    const uploader = new CUEUploader(uploaderOptions);

    try {
        // --- Example: Upload a single file ---
        const singleFilePath = "/path/to/your/small-file.txt"; // Replace with actual path
        const singleCollection = "my-test-collection";
        const singleUploadOpts = {
            targetPath: "js_uploads/single_files" // Optional remote sub-path
        };
        
        console.log(`Attempting to upload single file: ${singleFilePath}`);
        const singleResult = await uploader.upload(singleFilePath, singleCollection, singleUploadOpts);
        console.log("Single file upload successful:", singleResult);

        // --- Example: Upload a folder ---
        const folderPath = "/path/to/your/folder_to_upload"; // Replace with actual path
        const folderCollection = "my-test-collection";
        const folderUploadOpts = {
            targetPath: "js_uploads/folder_uploads", // Optional remote sub-path
            autoApprove: true // For library usage, confirmation should be handled by calling app if needed
        };

        console.log(`Attempting to upload folder: ${folderPath}`);
        const folderResult = await uploader.upload(folderPath, folderCollection, folderUploadOpts);
        console.log("Folder upload successful. Summary:", {
            totalFiles: folderResult.totalFiles,
            successfulUploads: folderResult.successfulUploads,
            failedUploads: folderResult.failedUploads
        });
        if (folderResult.failedUploads > 0) {
            console.log("Failed file details:", folderResult.results.filter(r => r.status === 'failed'));
        }

    } catch (error) {
        console.error("An error occurred during the upload process:", error.message);
        if (uploaderOptions.verboseLevel > 0 && error.stack) {
            console.error(error.stack);
        }
    }
}

// Create dummy files/folders for testing if they don't exist
// import fs from 'fs/promises';
// async function setupTestFiles() {
//     try {
//         await fs.mkdir('/path/to/your/folder_to_upload', { recursive: true });
//         await fs.writeFile('/path/to/your/small-file.txt', 'Hello world!');
//         await fs.writeFile('/path/to/your/folder_to_upload/file1.txt', 'File 1 content');
//         await fs.writeFile('/path/to/your/folder_to_upload/file2.txt', 'File 2 content');
//     } catch (e) { console.warn("Could not create test files/folders", e.message)}
// }
// setupTestFiles().then(runUpload);

runUpload(); // Make sure to replace paths in runUpload before running
