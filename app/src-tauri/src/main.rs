// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    waifufy_code_lib::run()
}
