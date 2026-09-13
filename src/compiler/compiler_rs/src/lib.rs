pub mod parser_wasm;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_miko(source: &str) -> Result<String, JsValue> {
    parser_wasm::parse_to_json(source).map_err(|e| JsValue::from_str(&e))
}
