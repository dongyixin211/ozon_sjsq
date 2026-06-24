mod core;

use core::{db::Database, jobs::JobRegistry};
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<Database>,
    pub jobs: JobRegistry,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let db = Database::open(app.handle())?;
            app.handle().manage(AppState {
                db: Mutex::new(db),
                jobs: JobRegistry::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core::commands::load_app_state,
            core::commands::save_settings,
            core::commands::save_provider_secrets,
            core::commands::save_xiaoqian_api_key,
            core::commands::save_shop,
            core::commands::delete_shop,
            core::commands::list_templates,
            core::commands::save_template,
            core::commands::delete_template,
            core::commands::test_ozon_connection,
            core::commands::list_ozon_products,
            core::commands::list_categories,
            core::commands::list_products_by_category,
            core::commands::list_product_analytics,
            core::commands::merge_product_cards,
            core::commands::get_product_info,
            core::commands::get_product_info_by_product_ids,
            core::commands::get_product_attributes,
            core::commands::get_product_description,
            core::commands::get_product_stocks,
            core::commands::list_warehouses,
            core::commands::get_import_info,
            core::commands::import_products,
            core::commands::update_category_products,
            core::commands::list_actions,
            core::commands::list_action_products,
            core::commands::list_action_candidates,
            core::commands::activate_action_products,
            core::commands::deactivate_action_products,
            core::commands::deactivate_all_action_products,
            core::commands::update_stocks,
            core::commands::update_prices,
            core::commands::generate_barcodes,
            core::commands::start_batch_upload,
            core::commands::preflight_materials,
            core::commands::preflight_batch_upload,
            core::commands::preflight_listed_update,
            core::commands::test_oss_upload,
            core::commands::start_listed_update,
            core::commands::start_order_documents,
            core::commands::save_shop_seller_cookie,
            core::commands::list_order_postings,
            core::commands::start_follow_sync,
            core::commands::start_follow_automation,
            core::commands::start_materials_job,
            core::commands::list_ai_models,
            core::commands::rename_material_images,
            core::commands::start_local_scene_job,
            core::commands::start_demo_job,
            core::commands::list_jobs,
            core::commands::list_job_logs,
            core::commands::cancel_job,
            core::commands::create_upload_template,
            core::commands::analyze_sku_folder,
            core::commands::build_import_preview,
            core::commands::open_path,
            core::commands::open_url,
            core::commands::pick_directory,
            core::commands::pick_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ozon SJSQ");
}
