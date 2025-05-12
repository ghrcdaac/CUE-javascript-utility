import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const APP_NAME = "cue-upload-js-lib"; 
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), `.${APP_NAME}`);
const DEFAULT_CONFIG_FILENAME = "config.json";

const defaultConfig = {
    api_token: null,
    default_env: "local",
    multipart_threshold_gb: 1,
    multipart_chunk_size_mb: 256,
    retry_attempts: 3,
    log_level: "INFO", // Controls internal logging if any, library users might have their own logger
    file_concurrency: 4,
    part_concurrency: 4,
    environments: {
        prod: "https://upload.earthdata.nasa.gov/api/v1/",
        uat: "https://upload.uat.earthdata.nasa.gov/api/v1/",
        sit: "https://upload.sit.earthdata.nasa.gov/api/v1/",
        local: "http://localhost:8000/v1/"
    },
    user_ignored_patterns: [
        ".DS_Store", "Thumbs.db", "*.tmp", "~$*", 
        "__pycache__/", "*.pyc", "*.pyo", ".log"
    ]
};

let _cachedConfig = null;
let _configPath = ''; // Stores the path of the loaded config

export function getConfigFilePath(configPathOverride = null) {
    if (configPathOverride) {
        return path.resolve(configPathOverride);
    }
    return path.join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILENAME);
}

export async function ensureConfigExists(configPathOverride = null) {
    const configFilePath = getConfigFilePath(configPathOverride);
    // _configPath = configFilePath; // Set when getConfig is called with specific path

    try {
        await fs.mkdir(path.dirname(configFilePath), { recursive: true });
        try {
            await fs.access(configFilePath);
        } catch {
            console.info(`[CUE Upload Lib] Configuration file not found at ${configFilePath}. Creating with defaults.`);
            await fs.writeFile(configFilePath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        }
    } catch (error) {
        console.error(`[CUE Upload Lib] Could not create config directory or file at ${configFilePath}:`, error);
        throw new Error(`Configuration setup failed: ${error.message}`);
    }
}

export async function getConfig(configPathOverride = null) {
    const targetConfigPath = getConfigFilePath(configPathOverride);

    if (_cachedConfig && _configPath === targetConfigPath) {
        return _cachedConfig;
    }

    await ensureConfigExists(targetConfigPath); 

    try {
        const fileContent = await fs.readFile(targetConfigPath, 'utf-8');
        const loadedConfig = JSON.parse(fileContent);
        _cachedConfig = { ...defaultConfig, ...loadedConfig, environments: {...defaultConfig.environments, ...(loadedConfig.environments || {})}};
        _configPath = targetConfigPath; // Cache the path of the loaded config
        return _cachedConfig;
    } catch (error) {
        console.error(`[CUE Upload Lib] Error loading or parsing configuration from ${targetConfigPath}:`, error);
        _cachedConfig = { ...defaultConfig }; // Fallback to default
        _configPath = targetConfigPath; // Still cache the path
        return _cachedConfig;
    }
}

export async function saveConfigValue(key, value, configPathOverride = null) {
    // For a library, direct saving might be less common; usually config is passed in.
    // However, keeping it for potential internal use or a helper CLI part.
    const currentConfig = await getConfig(configPathOverride); // ensures config is loaded
    const keys = key.split('.');
    let obj = currentConfig;
    keys.forEach((k, i) => {
        if (i === keys.length - 1) {
            obj[k] = value;
        } else {
            if (!obj[k] || typeof obj[k] !== 'object') obj[k] = {};
            obj = obj[k];
        }
    });

    const configFilePathToSave = getConfigFilePath(configPathOverride || _configPath); // Use cached path if no override
    try {
        await fs.writeFile(configFilePathToSave, JSON.stringify(currentConfig, null, 2), 'utf-8');
        _cachedConfig = null; // Invalidate cache
        console.info(`[CUE Upload Lib] Configuration updated: ${key} saved to ${configFilePathToSave}`);
    } catch (error) {
        console.error(`[CUE Upload Lib] Failed to save configuration to ${configFilePathToSave}:`, error);
        throw new Error(`Could not save configuration: ${error.message}`);
    }
}
