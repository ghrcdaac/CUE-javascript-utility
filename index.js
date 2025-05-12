import path from 'path';
import { getConfig as loadConfig, getAuthToken as loadAuthToken, ensureConfigExists as ensureBaseConfigExists } from './config.js';
import { ApiClient } from './apiClient.js';
import { processFolderUpload as doFolderUpload } from './folderProcessor.js';
import { handleSingleFileUpload as doSingleUpload } from './singleFileUploader.js';
import { handleMultipartUpload as doMultipartUpload } from './multipartUploader.js';
import { getFileSize, isFileTypeDisallowed, formatBytes } from './utils.js';
import fsPromises from 'fs/promises';


export class CUEUploader {
    constructor(options = {}) {
        // Options: token, env, configPath, 
        // fileConcurrency, partConcurrency, multipartThresholdGb, multipartChunkSizeMb
        // onFolderProgress, onFileProgress, onPartProgress
        this.options = options;
        this.config = null;
        this.apiClient = null;
        this.globalArgs = { // Mimic globalArgs structure for internal components
            tokenCli: options.token || null,
            envCli: options.env || null,
            configPathOverride: options.configPath || null,
            verboseLevel: options.verboseLevel || 0, // 0: info, 1: debug for lib
            quietMode: options.quietMode || false,
        };
    }

    async _initialize() {
        if (!this.config) {
            // Ensure base config directory/file exists if not overridden,
            // so getConfig doesn't fail if it's the very first run.
            await ensureBaseConfigExists(this.globalArgs.configPathOverride);
            this.config = await loadConfig(this.globalArgs.configPathOverride);
            
            // Override config with options if provided
            if (this.options.fileConcurrency) this.config.file_concurrency = this.options.fileConcurrency;
            if (this.options.partConcurrency) this.config.part_concurrency = this.options.partConcurrency;
            if (this.options.multipartThresholdGb) this.config.multipart_threshold_gb = this.options.multipartThresholdGb;
            if (this.options.multipartChunkSizeMb) this.config.multipart_chunk_size_mb = this.options.multipartChunkSizeMb;
            if (this.options.env) this.config.default_env = this.options.env; // Overrides default_env from file

            // Update globalArgs with the final effective env for apiClient
            this.globalArgs.envCli = this.options.env || this.config.default_env;
        }
        if (!this.apiClient) {
            const authToken = await loadAuthToken(this.options.token, this.globalArgs.configPathOverride);
            if (!authToken) {
                throw new Error("Authentication token is required. Provide via options.token, config file, or CUE_UPLOAD_API_TOKEN env var.");
            }
            this.apiClient = new ApiClient(this.config, this.globalArgs, authToken);
        }
    }

    /**
     * Uploads a single file or an entire folder.
     * @param {string} sourcePath - Absolute or relative path to the file or folder.
     * @param {string} collection - The target collection short_name.
     * @param {object} [options={}] - Additional options.
     * @param {string} [options.targetPath] - Remote sub-path within the collection.
     * @param {boolean} [options.autoApprove=true] - Skip confirmation for folder uploads (library defaults to true).
     * @param {function} [options.onFolderProgress] - Callback for folder progress updates.
     * @param {function} [options.onFileProgress] - Callback for individual file progress updates.
     * @param {function} [options.onPartProgress] - Callback for multipart part progress updates.
     * @returns {Promise<object>} A promise that resolves with an object containing upload results.
     */
    async upload(sourcePath, collection, uploadOptions = {}) {
        await this._initialize(); // Ensure config and apiClient are ready

        const absoluteSourcePath = path.resolve(sourcePath);
        const { 
            targetPath = null, 
            autoApprove = true, // Library defaults to auto-approve true
            onFolderProgress, 
            onFileProgress,
            onPartProgress 
        } = uploadOptions;

        const progressCallbacks = { onFolderProgress, onFileProgress, onPartProgressUpdate: onPartProgress };


        try {
            const stats = await fsPromises.stat(absoluteSourcePath);
            if (stats.isDirectory()) {
                return await doFolderUpload(
                    absoluteSourcePath, collection, targetPath,
                    this.apiClient, this.config, this.globalArgs,
                    this.config.file_concurrency, this.config.part_concurrency,
                    autoApprove, progressCallbacks
                );
            } else if (stats.isFile()) {
                if (isFileTypeDisallowed(absoluteSourcePath)) {
                    throw new Error(`File type ${path.extname(absoluteSourcePath)} is disallowed.`);
                }
                const fileSize = stats.size;
                const multipartThresholdBytes = this.config.multipart_threshold_gb * (1024 ** 3);

                if (fileSize > multipartThresholdBytes) {
                    return await doMultipartUpload(
                        absoluteSourcePath, fileSize, collection, targetPath,
                        this.apiClient, this.config, // globalArgs not directly needed by MPU handler
                        this.config.part_concurrency, progressCallbacks
                    );
                } else {
                    return await doSingleUpload(
                        absoluteSourcePath, fileSize, collection, targetPath,
                        this.apiClient, this.config, // globalArgs not directly needed by SFU handler
                        progressCallbacks
                    );
                }
            } else {
                throw new Error(`Source path is not a file or directory: ${absoluteSourcePath}`);
            }
        } catch (error) {
            console.error(`[CUE Upload Lib] FATAL UPLOAD ERROR for ${sourcePath}: ${error.message}`);
            if (this.globalArgs.verboseLevel > 0 && error.stack) console.error(error.stack);
            throw error; // Re-throw for the calling application to handle
        }
    }

    // Add methods for 'configure', 'logs', 'ignore' if this library needs to manage them directly
    // For now, 'configure' is mostly about setting the api_token in the config file.
    async setConfigValue(key, value) {
        // Ensures config dir/file exists if it's the first time anything is called.
        await ensureBaseConfigExists(this.globalArgs.configPathOverride); 
        return saveConfigValue(key, value, this.globalArgs.configPathOverride);
    }
}

// Example Usage (if this file were run directly, not typical for a library)
/*
async function example() {
    const uploader = new CUEUploader({
        token: "your_token_here_or_it_will_use_config_or_env",
        env: "local", // Optional: overrides config default_env
        // verboseLevel: 1,
        onFolderProgress: (progress) => console.log(`Folder Progress: ${progress.message}`, progress.details || ''),
        onFileProgress: (progress) => console.log(`  File (${progress.file}) Progress: ${progress.message}`, progress.details || ''),
        // onPartProgress: (partNum, loaded, total, statusMsg) => console.log(`    Part ${partNum}: ${statusMsg} ${loaded}/${total}`)
    });

    try {
        // await uploader.setConfigValue("api_token", "new_token_from_code");

        // const singleResult = await uploader.upload("./package.json", "my-test-collection", { targetPath: "js_tests/single" });
        // console.log("Single file upload result:", singleResult);

        const folderResult = await uploader.upload("./", "my-test-collection", { targetPath: "js_tests/folder_test" });
        console.log("Folder upload result:", folderResult);

    } catch (error) {
        console.error("Main example error:", error.message);
    }
}

// example();
*/
