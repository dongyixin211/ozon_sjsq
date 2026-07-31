use crate::core::{cloud_bridge, commands, device, models, product_catalog};
use crate::AppState;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::thread;
use std::time::Duration;

const LOCAL_ASSISTANT_PROTOCOL_VERSION: u32 = 4;
use tauri::Manager;

const LOCAL_ASSISTANT_PORT: u16 = 17641;
const WEB_APP_URL: &str = "https://api.dyxtoolai.cn/app/";

pub fn start(app: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", LOCAL_ASSISTANT_PORT)) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("本地助手启动失败: {error}");
                return;
            }
        };

        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                continue;
            };
            let app = app.clone();
            thread::spawn(move || {
                let _ = handle_stream(stream, app);
            });
        }
    });
}

fn handle_stream(mut stream: TcpStream, app: tauri::AppHandle) -> std::io::Result<()> {
    let request = read_request(&mut stream)?;
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let origin = allowed_origin(&request);

    if method == "OPTIONS" {
        return write_response(
            &mut stream,
            204,
            "text/plain; charset=utf-8",
            "",
            origin.as_deref(),
        );
    }

    if method == "GET" && path == "/health" {
        let body = serde_json::json!({
            "ok": true,
            "service": "ozon-sjsq-local-assistant",
            "version": app.package_info().version.to_string(),
            "protocolVersion": LOCAL_ASSISTANT_PROTOCOL_VERSION,
            "deviceFingerprint": device::fingerprint(&app),
            "webAppUrl": WEB_APP_URL,
            "capabilities": ["device_fingerprint", "open_browser", "local_files", "command_bridge", "local_cache", "sync_outbox", "product_catalog_sync"]
        })
        .to_string();
        return write_response(
            &mut stream,
            200,
            "application/json; charset=utf-8",
            &body,
            origin.as_deref(),
        );
    }

    if method == "POST" && path == "/command" {
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, value)| value)
            .unwrap_or_default();
        let result = catch_unwind(AssertUnwindSafe(|| {
            serde_json::from_str::<AssistantCommandRequest>(body)
                .map_err(|error| format!("命令请求格式不正确：{error}"))
                .and_then(|input| handle_command(app, input))
        }))
        .unwrap_or_else(|payload| {
            let message = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| {
                    payload
                        .downcast_ref::<&str>()
                        .map(|value| (*value).to_string())
                })
                .unwrap_or_else(|| "本地助手执行命令时发生内部错误".to_string());
            Err(message)
        });
        return match result {
            Ok(value) => write_json(&mut stream, 200, value, origin.as_deref()),
            Err(message) => write_json(
                &mut stream,
                500,
                json!({ "ok": false, "message": message }),
                origin.as_deref(),
            ),
        };
    }

    write_response(
        &mut stream,
        404,
        "application/json; charset=utf-8",
        r#"{"ok":false,"message":"接口不存在"}"#,
        origin.as_deref(),
    )
}

#[derive(Debug, Deserialize)]
struct AssistantCommandRequest {
    command: String,
    #[serde(default)]
    args: Value,
}

fn handle_command(app: tauri::AppHandle, input: AssistantCommandRequest) -> Result<Value, String> {
    let args = input.args;
    let state = app.state::<AppState>();
    match input.command.as_str() {
        "load_app_state" => to_value(commands::load_app_state(state)),
        "cloud_request" => to_value(tauri::async_runtime::block_on(cloud_bridge::request(
            app,
            arg(&args, "request")?,
        ))),
        "start_cloud_sync" => to_value(cloud_bridge::start_gallery_sync(
            app,
            arg(&args, "request")?,
        )),
        "cloud_sync_status" => to_value(cloud_bridge::sync_status(app, arg(&args, "accountId")?)),
        "start_product_catalog_sync" => {
            to_value(product_catalog::start(app, arg(&args, "request")?))
        }
        "get_device_fingerprint" => to_value(commands::get_device_fingerprint(app)),
        "save_settings" => to_value(commands::save_settings(state, arg(&args, "settings")?)),
        "save_provider_secrets" => to_value(commands::save_provider_secrets(
            arg(&args, "settings")?,
            arg(&args, "draft")?,
        )),
        "save_xiaoqian_api_key" => to_value(commands::save_xiaoqian_api_key(arg(&args, "apiKey")?)),
        "save_shop" => to_value(commands::save_shop(state, arg(&args, "draft")?)),
        "delete_shop" => to_value(commands::delete_shop(state, arg(&args, "id")?)),
        "list_templates" => to_value(commands::list_templates(state, arg(&args, "kind")?)),
        "save_template" => to_value(commands::save_template(state, arg(&args, "draft")?)),
        "delete_template" => to_value(commands::delete_template(state, arg(&args, "id")?)),
        "test_ozon_connection" => to_value(tauri::async_runtime::block_on(
            commands::test_ozon_connection(state, arg(&args, "shopId")?),
        )),
        "get_shop_upload_quota" => to_value(tauri::async_runtime::block_on(
            commands::get_shop_upload_quota(state, arg(&args, "shopId")?),
        )),
        "list_ozon_products" => to_value(tauri::async_runtime::block_on(
            commands::list_ozon_products(
                state,
                arg(&args, "shopId")?,
                optional_arg(&args, "visibility")?.unwrap_or_default(),
                optional_arg(&args, "limit")?.unwrap_or(50),
            ),
        )),
        "list_categories" => to_value(tauri::async_runtime::block_on(commands::list_categories(
            state,
            arg(&args, "shopId")?,
        ))),
        "list_products_by_category" => to_value(tauri::async_runtime::block_on(
            commands::list_products_by_category(
                state,
                arg(&args, "shopId")?,
                arg(&args, "categoryId")?,
                optional_arg(&args, "typeId")?,
                optional_arg(&args, "limit")?.unwrap_or(100),
            ),
        )),
        "list_product_analytics" => to_value(tauri::async_runtime::block_on(
            commands::list_product_analytics(
                state,
                arg(&args, "shopId")?,
                arg(&args, "dateFrom")?,
                arg(&args, "dateTo")?,
                optional_arg(&args, "limit")?.unwrap_or(1000),
            ),
        )),
        "merge_product_cards" => to_value(tauri::async_runtime::block_on(
            commands::merge_product_cards(state, arg(&args, "shopId")?, arg(&args, "productIds")?),
        )),
        "update_category_products" => to_value(tauri::async_runtime::block_on(
            commands::update_category_products(
                state,
                arg(&args, "shopId")?,
                arg(&args, "categoryId")?,
                optional_arg(&args, "typeId")?,
                optional_arg(&args, "cachedProducts")?,
                optional_arg(&args, "warehouseId")?,
                optional_arg(&args, "stock")?,
                optional_arg(&args, "price")?,
                optional_arg(&args, "oldPrice")?,
                optional_arg(&args, "currencyCode")?,
                optional_arg(&args, "updateStock")?.unwrap_or(false),
                optional_arg(&args, "updatePrice")?.unwrap_or(false),
            ),
        )),
        "get_product_info" => to_value(tauri::async_runtime::block_on(commands::get_product_info(
            state,
            arg(&args, "shopId")?,
            optional_arg(&args, "offerIds")?.unwrap_or_default(),
        ))),
        "get_product_info_by_product_ids" => to_value(tauri::async_runtime::block_on(
            commands::get_product_info_by_product_ids(
                state,
                arg(&args, "shopId")?,
                optional_arg(&args, "productIds")?.unwrap_or_default(),
            ),
        )),
        "get_product_attributes" => to_value(tauri::async_runtime::block_on(
            commands::get_product_attributes(
                state,
                arg(&args, "shopId")?,
                optional_arg(&args, "offerIds")?.unwrap_or_default(),
            ),
        )),
        "get_product_description" => to_value(tauri::async_runtime::block_on(
            commands::get_product_description(state, arg(&args, "shopId")?, arg(&args, "offerId")?),
        )),
        "get_product_stocks" => to_value(tauri::async_runtime::block_on(
            commands::get_product_stocks(
                state,
                arg(&args, "shopId")?,
                optional_arg(&args, "offerIds")?.unwrap_or_default(),
                optional_arg(&args, "productIds")?.unwrap_or_default(),
                optional_arg(&args, "visibility")?.unwrap_or_default(),
            ),
        )),
        "list_warehouses" => to_value(tauri::async_runtime::block_on(commands::list_warehouses(
            state,
            arg(&args, "shopId")?,
        ))),
        "get_import_info" => to_value(tauri::async_runtime::block_on(commands::get_import_info(
            state,
            arg(&args, "shopId")?,
            arg(&args, "taskId")?,
        ))),
        "import_products" => to_value(tauri::async_runtime::block_on(commands::import_products(
            state,
            arg(&args, "shopId")?,
            optional_arg(&args, "items")?.unwrap_or_default(),
        ))),
        "list_actions" => to_value(tauri::async_runtime::block_on(commands::list_actions(
            state,
            arg(&args, "shopId")?,
        ))),
        "list_action_products" => to_value(tauri::async_runtime::block_on(
            commands::list_action_products(
                state,
                arg(&args, "shopId")?,
                arg(&args, "actionId")?,
                optional_arg(&args, "limit")?.unwrap_or(100),
                optional_arg(&args, "lastId")?.unwrap_or_default(),
            ),
        )),
        "list_action_candidates" => to_value(tauri::async_runtime::block_on(
            commands::list_action_candidates(
                state,
                arg(&args, "shopId")?,
                arg(&args, "actionId")?,
                optional_arg(&args, "limit")?.unwrap_or(100),
                optional_arg(&args, "lastId")?.unwrap_or_default(),
            ),
        )),
        "activate_action_products" => to_value(tauri::async_runtime::block_on(
            commands::activate_action_products(
                state,
                arg(&args, "shopId")?,
                arg(&args, "actionId")?,
                optional_arg(&args, "products")?.unwrap_or_default(),
            ),
        )),
        "deactivate_action_products" => to_value(tauri::async_runtime::block_on(
            commands::deactivate_action_products(
                state,
                arg(&args, "shopId")?,
                arg(&args, "actionId")?,
                optional_arg(&args, "productIds")?.unwrap_or_default(),
            ),
        )),
        "deactivate_all_action_products" => to_value(tauri::async_runtime::block_on(
            commands::deactivate_all_action_products(
                state,
                arg(&args, "shopId")?,
                arg(&args, "actionId")?,
            ),
        )),
        "update_stocks" => to_value(tauri::async_runtime::block_on(commands::update_stocks(
            state,
            arg(&args, "shopId")?,
            optional_arg(&args, "stocks")?.unwrap_or_default(),
        ))),
        "update_prices" => to_value(tauri::async_runtime::block_on(commands::update_prices(
            state,
            arg(&args, "shopId")?,
            optional_arg(&args, "prices")?.unwrap_or_default(),
        ))),
        "generate_barcodes" => {
            to_value(tauri::async_runtime::block_on(commands::generate_barcodes(
                state,
                arg(&args, "shopId")?,
                optional_arg(&args, "productIds")?.unwrap_or_default(),
            )))
        }
        "start_batch_upload" => {
            to_value(commands::start_batch_upload(state, arg(&args, "request")?))
        }
        "start_auto_listing" => {
            to_value(commands::start_auto_listing(state, arg(&args, "request")?))
        }
        "scheduler_status" => to_value(commands::scheduler_status(
            app.state(),
            arg(&args, "request")?,
        )),
        "run_auto_listing_plan_now" => to_value(tauri::async_runtime::block_on(
            commands::run_auto_listing_plan_now(app.clone(), app.state(), arg(&args, "request")?),
        )),
        "pause_auto_listing_plan" => to_value(commands::pause_auto_listing_plan(
            app.state(),
            arg(&args, "request")?,
        )),
        "start_local_mockup_render" => to_value(commands::start_local_mockup_render(
            app.clone(),
            state,
            arg(&args, "request")?,
        )),
        "read_local_mockup_result" => to_value(commands::read_local_mockup_result(arg(
            &args,
            "resultPath",
        )?)),
        "start_listing_image_repair" => to_value(commands::start_listing_image_repair(
            state,
            arg(&args, "request")?,
        )),
        "preflight_materials" => {
            to_value(commands::preflight_materials(state, arg(&args, "request")?))
        }
        "preflight_batch_upload" => to_value(commands::preflight_batch_upload(
            state,
            arg(&args, "request")?,
        )),
        "preflight_listed_update" => to_value(tauri::async_runtime::block_on(
            commands::preflight_listed_update(state, arg(&args, "request")?),
        )),
        "test_oss_upload" => to_value(tauri::async_runtime::block_on(commands::test_oss_upload(
            state,
            arg(&args, "shopId")?,
        ))),
        "start_listed_update" => {
            to_value(commands::start_listed_update(state, arg(&args, "request")?))
        }
        "reserve_order_shipping_labels" => to_value(commands::reserve_order_shipping_labels(
            state,
            arg(&args, "assignments")?,
        )),
        "download_order_shipping_labels" => to_value(tauri::async_runtime::block_on(
            commands::download_order_shipping_labels(state, arg(&args, "request")?),
        )),
        "start_order_documents" => to_value(commands::start_order_documents(
            state,
            arg(&args, "request")?,
        )),
        "save_shop_seller_cookie" => to_value(commands::save_shop_seller_cookie(
            state,
            arg(&args, "shopId")?,
            arg(&args, "cookie")?,
        )),
        "list_order_postings" => to_value(tauri::async_runtime::block_on(
            commands::list_order_postings(state, arg(&args, "request")?),
        )),
        "list_saved_order_postings" => to_value(commands::list_saved_order_postings(
            state,
            arg(&args, "query")?,
        )),
        "ship_order_posting" => to_value(tauri::async_runtime::block_on(
            commands::ship_order_posting(
                state,
                arg(&args, "shopId")?,
                arg(&args, "postingNumber")?,
            ),
        )),
        "start_follow_sync" => to_value(commands::start_follow_sync(
            state,
            arg(&args, "shopId")?,
            optional_arg(&args, "priceMultiplier")?,
        )),
        "start_follow_automation" => to_value(commands::start_follow_automation(
            state,
            arg(&args, "request")?,
        )),
        "start_listing_maintenance" => to_value(commands::start_listing_maintenance(
            state,
            arg(&args, "request")?,
        )),
        "start_materials_job" => {
            to_value(commands::start_materials_job(state, arg(&args, "request")?))
        }
        "scan_gallery_upload_files" => {
            to_value(commands::scan_gallery_upload_files(arg(&args, "paths")?))
        }
        "start_gallery_upload_job" => to_value(commands::start_gallery_upload_job(
            state,
            arg(&args, "request")?,
        )),
        "list_ai_models" => to_value(tauri::async_runtime::block_on(commands::list_ai_models(
            arg(&args, "baseUrl")?,
            arg(&args, "provider")?,
            optional_arg(&args, "cloudAuthToken")?,
            optional_arg(&args, "kind")?,
        ))),
        "rename_material_images" => {
            to_value(commands::rename_material_images(arg(&args, "request")?))
        }
        "start_local_scene_job" => to_value(commands::start_local_scene_job(
            state,
            arg(&args, "request")?,
        )),
        "start_demo_job" => to_value(commands::start_demo_job(
            state,
            arg::<models::JobKind>(&args, "kind")?,
            arg(&args, "title")?,
        )),
        "list_jobs" => to_value(commands::list_jobs(state)),
        "list_job_logs" => to_value(commands::list_job_logs(state, arg(&args, "jobId")?)),
        "cancel_job" => to_value(commands::cancel_job(state, arg(&args, "jobId")?)),
        "create_upload_template" => to_value(commands::create_upload_template(arg(&args, "path")?)),
        "analyze_sku_folder" => to_value(commands::analyze_sku_folder(arg(&args, "path")?)),
        "build_import_preview" => to_value(commands::build_import_preview(arg(&args, "input")?)),
        "open_path" => to_value(commands::open_path(arg(&args, "path")?)),
        "open_url" => to_value(commands::open_url(arg(&args, "url")?)),
        "pick_directory" => to_value(commands::pick_directory()),
        "pick_file" => to_value(commands::pick_file()),
        "pick_image_files" => to_value(commands::pick_image_files()),
        other => Err(format!("本地助手不支持命令：{other}")),
    }
}

fn to_value<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args
        .get(name)
        .cloned()
        .ok_or_else(|| format!("缺少参数：{name}"))?;
    serde_json::from_value(value).map_err(|error| format!("参数 {name} 格式不正确：{error}"))
}

fn optional_arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Option<T>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("参数 {name} 格式不正确：{error}")),
    }
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let size = stream.read(&mut chunk)?;
        if size == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..size]);
        if let Some(header_end) = find_header_end(&buffer) {
            let headers = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = content_length(&headers);
            let body_len = buffer.len().saturating_sub(header_end + 4);
            if body_len >= content_length {
                break;
            }
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn allowed_origin(request: &str) -> Option<String> {
    let origin = request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("origin")
            .then(|| value.trim().to_string())
    })?;
    if origin == "https://api.dyxtoolai.cn"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
    {
        Some(origin)
    } else {
        Some("https://api.dyxtoolai.cn".to_string())
    }
}

fn write_json(
    stream: &mut TcpStream,
    status: u16,
    body: Value,
    origin: Option<&str>,
) -> std::io::Result<()> {
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &body.to_string(),
        origin,
    )
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
    origin: Option<&str>,
) -> std::io::Result<()> {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let origin = origin.unwrap_or("https://api.dyxtoolai.cn");
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: {origin}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Access-Control-Max-Age: 600\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.as_bytes().len(),
    );
    stream.write_all(response.as_bytes())
}
