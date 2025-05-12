import crypto from 'crypto';
import fsPromises from 'fs/promises';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';

const DEFAULT_INTERNAL_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export async function calculateSHA256Checksum(filePath, chunkSize = DEFAULT_INTERNAL_CHUNK_SIZE_BYTES) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('base64')));
        stream.on('error', (err) => {
            console.error(`[CUE Upload Lib] Error calculating SHA256 for ${filePath}:`, err);
            reject(new Error(`Checksum calculation failed for ${filePath}: ${err.message}`));
        });
    });
}

export function calculateSHA256ChecksumForBytes(buffer) {
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return hash.digest('base64');
}

export async function getFileSize(filePath) {
    try {
        const stats = await fsPromises.stat(filePath);
        return stats.size;
    } catch (error) {
        console.error(`[CUE Upload Lib] Error getting size of file ${filePath}:`, error);
        throw new Error(`Could not get size of file ${filePath}: ${error.message}`);
    }
}

export function getMimeType(filePath) {
    const detectedMime = mime.lookup(filePath);
    if (detectedMime) return detectedMime;
    const ext = path.extname(filePath).toLowerCase();
    const extMap = {
        '.zip': 'application/zip', '.txt': 'text/plain', '.json': 'application/json',
        '.xml': 'application/xml', '.csv': 'text/csv', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.pdf': 'application/pdf', '.tar': 'application/x-tar', '.gz': 'application/gzip',
    };
    if (extMap[ext]) return extMap[ext];
    console.warn(`[CUE Upload Lib] Could not determine specific MIME type for ${path.basename(filePath)}. Defaulting to application/octet-stream.`);
    return "application/octet-stream";
}

export async function* readFileChunks(filePath, chunkSize) {
    let fileHandle;
    try {
        fileHandle = await fsPromises.open(filePath, 'r');
        const buffer = Buffer.alloc(chunkSize);
        while (true) {
            const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, null);
            if (bytesRead === 0) break;
            yield buffer.subarray(0, bytesRead);
        }
    } catch (error) {
        console.error(`[CUE Upload Lib] Error reading file ${filePath} in chunks:`, error);
        throw new Error(`Could not read file ${filePath} in chunks: ${error.message}`);
    } finally {
        if (fileHandle) await fileHandle.close();
    }
}

export function formatBytes(sizeBytes) {
    if (sizeBytes === 0) return "0 B";
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let i = 0; let size = sizeBytes;
    while (size >= 1024 && i < units.length -1) { size /= 1024.0; i++; }
    return `${size.toFixed(2)} ${units[i]}`;
}

const DISALLOWED_EXTENSIONS = ['.dll', '.exe'];
export function isFileTypeDisallowed(filePath) {
    return DISALLOWED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function globToRegex(glob) {
    const specialChars = /[.+?^${}()|[\]\\]/g; 
    let regexStr = glob.replace(specialChars, '\\$&'); 
    regexStr = regexStr.replace(/\*\*/g, '.*'); 
    regexStr = regexStr.replace(/\*/g, '[^/]*'); 
    regexStr = regexStr.replace(/\?/g, '[^/]');   
    if (regexStr.endsWith('/')) {
        regexStr = `^${regexStr.slice(0, -1)}(?:/.*)?$`;
    } else {
        regexStr = `^${regexStr}$`; 
    }
    return new RegExp(regexStr, 'i'); 
}

export function isPathIgnored(pathToTest, basePath, ignorePatterns) {
    const relativePath = path.relative(basePath, pathToTest);
    const name = path.basename(pathToTest);
    for (const pattern of ignorePatterns) {
        const regex = globToRegex(pattern);
        if (regex.test(name) || (relativePath && regex.test(relativePath))) {
            // console.debug(`[CUE Upload Lib] Path '${pathToTest}' matched ignore pattern '${pattern}'.`);
            return true;
        }
    }
    return false;
}