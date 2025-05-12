# CUE Upload JavaScript Library

**Version:** 0.1.0
**License:** Apache-2.0

## Overview

The CUE Upload JavaScript Library provides a programmatic interface for Node.js applications to upload files and entire folder structures to the CUE (Cloud Upload Environment) backend system. It mirrors the core functionalities of the Python-based `cue-upload` CLI, including single-part/multipart uploads, checksum validation, and configuration management.

This library is intended for developers who need to integrate CUE upload capabilities directly into their Node.js applications or build custom upload workflows.

## Features

* Programmatic API for uploading individual files or entire directories recursively.
* Automatic handling of single-part vs. multipart uploads based on file size.
* Concurrent uploads for multiple files within a folder and for parts of a single large file.
* SHA256 checksum calculation for data integrity.
* Configuration via a `config.json` file, environment variables, or direct options.
* Support for different backend environments (prod, uat, sit, local).
* Applies ignored file patterns during folder scans.
* Client-side retries with exponential backoff for transient API errors.
* (Optional) Progress callbacks for monitoring upload status.

## Prerequisites

* **Node.js:** Version 18.0.0 or newer (due to use of global `fetch` and `crypto` APIs).

## Installation

```bash
npm install js-cue-upload-utility # Or your published package name
# or
yarn add js-cue-upload-utility
```

If you are using it directly from this source:

```bash
npm install # To install dependencies like mime-types and axios
```
## Configuration

The library can load configuration from ~/.cue-upload-js-lib/config.json. This file is automatically created with defaults if it doesn't exist when the library is initialized.

Default Configuration (config.json):

```
{
  "api_token": null,
  "default_env": "local",
  "multipart_threshold_gb": 1,
  "multipart_chunk_size_mb": 256,
  "retry_attempts": 3,
  "log_level": "INFO",
  "file_concurrency": 4,
  "part_concurrency": 4,
  "environments": {
    "prod": "[https://upload.earthdata.nasa.gov/api/v1/](https://upload.earthdata.nasa.gov/api/v1/)",
    "uat": "[https://upload.uat.earthdata.nasa.gov/api/v1/](https://upload.uat.earthdata.nasa.gov/api/v1/)",
    "sit": "[https://upload.sit.earthdata.nasa.gov/api/v1/](https://upload.sit.earthdata.nasa.gov/api/v1/)",
    "local": "http://localhost:8000/v1/"
  },
  "user_ignored_patterns": [
    ".DS_Store",
    "Thumbs.db",
    "*.tmp",
    // ... other defaults
  ]
}
```

Setting the API Token:
The API token is crucial for authentication. It can be provided in the following ways (listed by order of precedence):

Directly via the token option when instantiating CUEUploader.
In the api_token field of your config.json file.
As an environment variable: CUE_UPLOAD_API_TOKEN.


```

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

```

## CUEUploader Class
## Constructor

new CUEUploader(options = {})

options (Object): Optional configuration overrides and callbacks.
token (String): API JWT token.
env (String): Target environment (prod, uat, sit, local). Overrides default_env in config.json.
configPath (String): Absolute path to a custom config.json file.
verboseLevel (Number): 0 for standard info, 1 or more for debug console logs from the library.
quietMode (Boolean): Suppress most console output from the library.
fileConcurrency (Number): Overrides file_concurrency from config.json.
partConcurrency (Number): Overrides part_concurrency from config.json.
multipartThresholdGb (Number): Overrides multipart_threshold_gb from config.json.
multipartChunkSizeMb (Number): Overrides multipart_chunk_size_mb from config.json.
onFolderProgress (Function): Callback for folder upload progress. Receives an object like { folder, message, type, filesProcessed, totalFiles, loaded, total, phase }.
onFileProgress (Function): Callback for individual file (single or multipart overall) progress. Receives an object like { file, message, type, loaded, total, phase }.
onPartProgress (Function): Callback for multipart part progress. Receives (partNum, loadedBytes, totalPartBytes, statusMessage).

## Methods

async upload(sourcePath, collection, uploadOptions = {})
Uploads a single file or an entire folder.

sourcePath (String): Absolute or relative path to the file or folder.
collection (String): The target CUE collection short_name.
uploadOptions (Object):
targetPath (String, Optional): Remote sub-path within the collection where files will be placed.
autoApprove (Boolean, Optional, Default: true for library): If uploading a folder, skips any confirmation. The calling application should handle confirmation logic if needed.
Returns: A Promise that resolves with an object containing upload results.
For single file: { file, status, s3_key, location? }
For folder: { totalFiles, successfulUploads, failedUploads, results: Array<fileTaskResult> }
async setConfigValue(key, value)
Programmatically saves a value to the configuration file.

key (String): The configuration key (e.g., "api_token", "default_env").
value (Any): The value to save.

## Development
(Clone the repository, run npm install to get dependencies like axios and mime-types. Use linters/formatters as desired.)

## License
This project is licensed under the Apache License, Version 2.0.