import { calculateSHA256Checksum, getMimeType, formatBytes, isFileTypeDisallowed } from './utils.js';
import fsPromises from 'fs/promises';
import path from 'path';

export async function handleSingleFileUpload(
    filePath, fileSize, collection, targetSubPath,
    apiClient, config, // globalArgs removed, env is part of apiClient.config now
    options = {} // For progress callbacks, etc.
) {
    const { onProgress } = options; // Example of a progress callback
    const baseName = path.basename(filePath);

    const logPrefix = "[CUE Upload Lib]";
    const notifyProgress = (message, type = "info", details = {}) => {
        if (onProgress) onProgress({ file: baseName, message, type, ...details });
        else console.log(`${logPrefix} ${type.toUpperCase()}: ${message}`);
    };

    notifyProgress(`Preparing single file upload for: ${baseName} (${formatBytes(fileSize)})`);

    if (isFileTypeDisallowed(filePath)) {
        throw new Error(`Disallowed file type: ${path.extname(filePath)}`);
    }

    let s3ETag = null;
    let presignedInfoResponse;

    try {
        notifyProgress(`Calculating SHA256 checksum for ${baseName}...`);
        const checksumSHA256 = await calculateSHA256Checksum(filePath);
        notifyProgress(`SHA256 for ${baseName}: ${checksumSHA256}`, "debug");

        const mimeType = getMimeType(filePath);
        notifyProgress(`MIME type for ${baseName}: ${mimeType}`, "debug");

        const initiatePayload = {
            file_name: baseName, collection, size: fileSize, checksum: checksumSHA256,
            file_type: mimeType, collection_path: targetSubPath
        };

        for (let attempt = 0; attempt <= config.retry_attempts; attempt++) {
            try {
                notifyProgress(`Requesting upload URL for ${baseName} (attempt ${attempt + 1}/${config.retry_attempts + 1})...`);
                presignedInfoResponse = await apiClient.getPresignedUrlSingle(initiatePayload);
                notifyProgress(`Received presigned URL info. S3 Key: ${presignedInfoResponse.s3_key}`);
                break;
            } catch (error) {
                notifyProgress(`Attempt ${attempt + 1} to get presigned URL failed: ${error.message}`, "warn");
                if (attempt >= config.retry_attempts) {
                    throw new Error(`Failed to get presigned URL after ${config.retry_attempts + 1} attempts: ${error.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, (2 ** attempt) * 1000));
            }
        }
        if (!presignedInfoResponse) throw new Error("Failed to obtain presigned URL.");

        if (presignedInfoResponse.fields) {
            notifyProgress(`Uploading ${baseName} to S3 (Presigned POST)...`);
            const s3Response = await apiClient.uploadToS3PresignedPost(
                presignedInfoResponse.url, presignedInfoResponse.fields,
                filePath, baseName, mimeType
            );
            if (s3Response.status === 204) {
                s3ETag = s3Response.headers.get ? s3Response.headers.get("etag")?.replace(/"/g, "") : s3Response.headers["etag"]?.replace(/"/g, "");
                notifyProgress(`Successfully uploaded ${baseName} to S3 (POST). ETag: ${s3ETag}`);
            } else {
                throw new Error(`S3 upload (POST) failed with status ${s3Response.status}.`);
            }
        } else {
            notifyProgress(`Uploading ${baseName} to S3 (Presigned PUT)...`);
            const fileData = await fsPromises.readFile(filePath);
            const s3ResponsePut = await apiClient.uploadPartToS3PresignedPut(
                presignedInfoResponse.url, fileData
            );
            if (s3ResponsePut.status === 200) {
                s3ETag = s3ResponsePut.headers.get ? s3ResponsePut.headers.get("etag")?.replace(/"/g, "") : s3ResponsePut.headers["etag"]?.replace(/"/g, "");
                notifyProgress(`Successfully uploaded ${baseName} to S3 (PUT). ETag: ${s3ETag}`);
            } else {
                throw new Error(`S3 upload (PUT) failed with status ${s3ResponsePut.status}.`);
            }
        }

        const confirmPayload = {
            s3_key: presignedInfoResponse.s3_key, file_name: baseName, collection,
            size_bytes: fileSize, checksum: checksumSHA256, file_type: mimeType,
            collection_path: targetSubPath, s3_etag: s3ETag || null
        };
        notifyProgress(`Confirming upload of ${baseName} with backend...`);
        await apiClient.confirmSingleUpload(confirmPayload);
        notifyProgress(`Successfully uploaded and confirmed ${baseName}.`, "success");
        return { file: baseName, status: "success", s3_key: presignedInfoResponse.s3_key };

    } catch (error) {
        notifyProgress(`Single file upload failed for ${baseName}: ${error.message}`, "error");
        throw error;
    }
}