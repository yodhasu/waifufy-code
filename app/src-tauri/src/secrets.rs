// Mod secret settings (WC-20): API keys and tokens a mod declares as `secret` fields live in the OS credential
// store (Windows Credential Manager, macOS Keychain, Secret Service), never in a file. One entry per mod and
// setting: service "waifufy-mod:<id>", account = the setting key. The page reads them back to re-send to the link.

use keyring::{Entry, Error};

fn entry(service: &str, key: &str) -> Result<Entry, String> {
    // Only our own namespace: the page cannot read other apps' credentials through these commands.
    if !service.starts_with("waifufy-mod:") {
        return Err("not a mod secret".into());
    }
    Entry::new(service, key).map_err(|e| e.to_string())
}

/// The stored secret, or null when there is none.
#[tauri::command]
pub fn secret_get(service: String, key: String) -> Result<Option<String>, String> {
    match entry(&service, &key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(service: String, key: String, value: String) -> Result<(), String> {
    entry(&service, &key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Deleting a secret that is not there is fine.
#[tauri::command]
pub fn secret_delete(service: String, key: String) -> Result<(), String> {
    match entry(&service, &key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
