import axios from 'axios'; // Using axios
import { URL } from 'url';

const DEFAULT_API_TIMEOUT = 30000; // 30 seconds

export class ApiClient {
    constructor(config, globalArgs, authToken) { // globalArgs might be simplified to just env
        this.config = config;
        this.env = globalArgs.envCli || config.default_env; // Determine env once
        this.authToken = authToken;
        this.baseUrl = this._getBaseUrl();
        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            timeout: DEFAULT_API_TIMEOUT,
            headers: this._getDefaultHeaders()
        });
    }

    _getBaseUrl() {
        const url = this.config.environments[this.env];
        if (!url) {
            throw new Error(`Environment URL for '${this.env}' not found in configuration.`);
        }
        return url;
    }

    _getDefaultHeaders() {
        return {
            "Authorization": `Bearer ${this.authToken}`,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": `JS-CUE-Upload-Library/0.1.0`
        };
    }

    async _request(method, endpoint, jsonData = null, expectedStatusCodes = [200, 201, 204], customHeaders = {}) {
        const url = endpoint; // Axios handles baseURL
        const config = {
            method: method,
            url: url,
            headers: customHeaders, // Default headers are part of client instance
        };
        if (jsonData) {
            config.data = jsonData;
        } else if (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT') {
             // For axios, if no data, Content-Type might still be sent by default.
             // If backend is strict, ensure it's removed or set to appropriate type for empty body.
        }
        
        console.debug(`[CUE Upload Lib] API Request: ${method.toUpperCase()} ${this.baseUrl}${url}`);
        if (jsonData) console.debug(`[CUE Upload Lib] API Payload:`, JSON.stringify(jsonData, null, 2).substring(0, 500));

        try {
            const response = await this.httpClient.request(config);
            console.debug(`[CUE Upload Lib] API Response: ${response.status} ${response.statusText}`);

            if (!expectedStatusCodes.includes(response.status)) {
                const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                console.error(`[CUE Upload Lib] API Error: ${response.status} on ${method} ${url}. Response: ${errorText.substring(0,500)}`);
                throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
            }
            return response.data; // Axios automatically parses JSON
        } catch (error) {
            if (error.response) { // Error from server (e.g. 4xx, 5xx)
                console.error(`[CUE Upload Lib] API Error ${error.response.status} for ${url}:`, error.response.data);
                throw new Error(`API request failed: ${error.response.status}. ${JSON.stringify(error.response.data)}`);
            } else if (error.request) { // Request made but no response
                console.error(`[CUE Upload Lib] API Error: No response received for ${url}:`, error.message);
                throw new Error(`No response from server for ${url}: ${error.message}`);
            } else { // Setup error
                console.error(`[CUE Upload Lib] API Error: Request setup error for ${url}:`, error.message);
                throw new Error(`Request setup error for ${url}: ${error.message}`);
            }
        }
    }
    // Single File
    async getPresignedUrlSingle(payload) { return this._request("POST", "upload/upload_url", payload); }
    async confirmSingleUpload(payload) { return this._request("POST", "upload/confirm_single", payload, [200, 201]); }
    // Multipart
    async startMultipartUpload(payload) { return this._request("POST", "multipart/start", payload); }
    async getPresignedUrlForPart(payload) { return this._request("POST", "multipart/get_part_url", payload); }
    async completeMultipartUpload(payload) { return this._request("POST", "multipart/complete", payload); }
    async abortMultipartUpload(payload) { return this._request("POST", "multipart/abort", payload, [204]); }

    // S3 Direct Upload Helpers (using axios for consistency)
    async uploadToS3PresignedPost(url, fields, filePath, fileName, contentType) {
        const fileBuffer = await fsPromises.readFile(filePath);
        const formData = new FormData();
        for (const key in fields) {
            formData.append(key, fields[key]);
        }
        formData.append('file', new Blob([fileBuffer], { type: contentType }), fileName);

        console.debug(`[CUE Upload Lib] S3 POST: URL=${url}, File=${fileName}`);
        try {
            const response = await axios.post(url, formData, {
                headers: {
                    // FormData sets Content-Type automatically
                },
                timeout: 0 // Potentially long uploads, disable axios timeout for this call
            });
            console.debug(`[CUE Upload Lib] S3 POST Response: ${response.status} ${response.statusText}`);
            if (![200, 204].includes(response.status)) {
                throw new Error(`S3 presigned POST failed: ${response.status}. ${response.data}`);
            }
            return { status: response.status, headers: response.headers };
        } catch (error) {
            console.error(`[CUE Upload Lib] S3 presigned POST HTTP error for ${fileName}:`, error.response?.data || error.message);
            throw error;
        }
    }

    async uploadPartToS3PresignedPut(url, partDataBuffer) {
        const headers = { 'Content-Length': String(partDataBuffer.byteLength) };
        console.debug(`[CUE Upload Lib] S3 PUT Part: URL ending ...${url.slice(-50)}, Size=${partDataBuffer.byteLength}`);
        try {
            const response = await axios.put(url, partDataBuffer, {
                headers: headers,
                timeout: 0 // Disable timeout for part uploads
            });
            console.debug(`[CUE Upload Lib] S3 PUT Part Response: ${response.status} ${response.statusText}, ETag: ${response.headers['etag']}`);
            if (response.status !== 200) {
                throw new Error(`S3 presigned PUT for part failed: ${response.status}. ${response.data}`);
            }
            return { status: response.status, headers: response.headers };
        } catch (error) {
            console.error(`[CUE Upload Lib] S3 presigned PUT part HTTP error:`, error.response?.data || error.message);
            throw error;
        }
    }
}
