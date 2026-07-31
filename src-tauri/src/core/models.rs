use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shop {
    pub id: String,
    pub name: String,
    pub client_id: String,
    pub api_key_stored: bool,
    pub oss_access_key_id: Option<String>,
    pub oss_access_key_stored: bool,
    pub oss_bucket: Option<String>,
    pub oss_endpoint: Option<String>,
    pub oss_public_domain: Option<String>,
    pub watermark_path: Option<String>,
    pub shop_role: Option<String>,
    pub follows_shop_id: Option<String>,
    pub follow_warehouse_id: Option<i64>,
    pub maintenance_warehouse_id: Option<i64>,
    pub maintenance_stock: Option<i64>,
    pub maintenance_stock_enabled: bool,
    pub maintenance_barcode_enabled: bool,
    pub maintenance_action_enabled: bool,
    pub maintenance_interval_minutes: Option<i64>,
    pub maintenance_action_configs: Vec<ListingMaintenanceActionConfig>,
    pub ozon_seller_cookie_stored: bool,
    pub api_key_plain: Option<String>,
    pub oss_secret_plain: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopDraft {
    pub id: Option<String>,
    pub name: String,
    pub client_id: String,
    pub api_key: Option<String>,
    pub oss_access_key_id: Option<String>,
    pub oss_access_key_secret: Option<String>,
    pub oss_bucket: Option<String>,
    pub oss_endpoint: Option<String>,
    pub oss_public_domain: Option<String>,
    pub watermark_path: Option<String>,
    pub shop_role: Option<String>,
    pub follows_shop_id: Option<String>,
    pub follow_warehouse_id: Option<i64>,
    pub maintenance_warehouse_id: Option<i64>,
    pub maintenance_stock: Option<i64>,
    #[serde(default = "default_true")]
    pub maintenance_stock_enabled: bool,
    #[serde(default = "default_true")]
    pub maintenance_barcode_enabled: bool,
    #[serde(default = "default_true")]
    pub maintenance_action_enabled: bool,
    pub maintenance_interval_minutes: Option<i64>,
    #[serde(default)]
    pub maintenance_action_configs: Vec<ListingMaintenanceActionConfig>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingMaintenanceActionConfig {
    pub category_id: i64,
    pub category_name: Option<String>,
    pub action_id: i64,
    pub action_title: Option<String>,
    pub action_price: String,
    pub action_stock: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub cloud_api_base_url: String,
    pub default_source_root: String,
    pub default_output_root: String,
    pub baidu_cookie: String,
    pub watermark_path: String,
    pub content_root: String,
    pub upload_excel_path: String,
    pub upload_max_items: i64,
    pub listed_update_max_workers: i64,
    pub image_provider: String,
    pub text_provider: String,
    pub image_base_url: String,
    pub text_base_url: String,
    pub image_model: String,
    pub text_model: String,
    pub max_workers: i64,
    pub max_folders: i64,
    pub export_excel: bool,
    pub convert_originals: bool,
    pub generate_copy: bool,
    pub quality: String,
    pub scene_source_root: String,
    pub scene_output_root: String,
    pub scene_mockup_root: String,
    pub scene_single_image: String,
    pub scene_aspect_ratio: String,
    pub scene_count: i64,
    pub scene_max_workers: i64,
    pub scene_max_folders: i64,
    pub scene_size_label: String,
    pub scene_prompt_template: String,
    pub image_prompt_template: String,
    pub title_prompt_template: String,
    pub description_prompt_template: String,
    pub selected_template_name: String,
    pub material_portrait_source_root: String,
    pub material_portrait_output_root: String,
    pub material_portrait_max_items: i64,
    pub material_title_source_root: String,
    pub material_title_output_root: String,
    pub material_title_max_items: i64,
    pub material_rename_source_root: String,
    pub material_rename_output_root: String,
    pub material_rename_prefix: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            cloud_api_base_url: "https://api.dyxtoolai.cn".into(),
            default_source_root: String::new(),
            default_output_root: String::new(),
            baidu_cookie: String::new(),
            watermark_path: String::new(),
            content_root: String::new(),
            upload_excel_path: String::new(),
            upload_max_items: 100,
            listed_update_max_workers: 2,
            image_provider: "pixel".into(),
            text_provider: "xiaoqian".into(),
            image_base_url: "https://ai-pixel.online/v1".into(),
            text_base_url: "https://xiaoqian.art/v1".into(),
            image_model: "gpt-image-2".into(),
            text_model: "gpt-5-high".into(),
            max_workers: 3,
            max_folders: 0,
            export_excel: true,
            convert_originals: true,
            generate_copy: false,
            quality: "high".into(),
            scene_source_root: String::new(),
            scene_output_root: String::new(),
            scene_mockup_root: String::new(),
            scene_single_image: String::new(),
            scene_aspect_ratio: "1:1".into(),
            scene_count: 8,
            scene_max_workers: 2,
            scene_max_folders: 0,
            scene_size_label: String::new(),
            scene_prompt_template: String::new(),
            image_prompt_template: String::new(),
            title_prompt_template: String::new(),
            description_prompt_template: String::new(),
            selected_template_name: String::new(),
            material_portrait_source_root: String::new(),
            material_portrait_output_root: String::new(),
            material_portrait_max_items: 0,
            material_title_source_root: String::new(),
            material_title_output_root: String::new(),
            material_title_max_items: 0,
            material_rename_source_root: String::new(),
            material_rename_output_root: String::new(),
            material_rename_prefix: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub settings: AppSettings,
    pub shops: Vec<Shop>,
    pub jobs: Vec<JobSummary>,
    pub provider_secrets: ProviderSecretStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretStatus {
    pub image_api_key_stored: bool,
    pub text_api_key_stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretDraft {
    pub image_api_key: Option<String>,
    pub text_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub payload: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDraft {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Materials,
    SceneLocal,
    SceneAi,
    LocalMockup,
    AutoListing,
    GalleryUpload,
    BatchUpload,
    ListingImageRepair,
    ListedUpdate,
    FollowSync,
    FollowAutomation,
    ListingMaintenance,
    Inventory,
    Barcode,
    OrderDocuments,
    ApiTest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub kind: JobKind,
    pub title: String,
    pub status: JobStatus,
    pub progress: u8,
    pub input_path: Option<String>,
    pub output_path: Option<String>,
    pub result_path: Option<String>,
    pub result_excel_path: Option<String>,
    pub success_count: Option<usize>,
    pub failed_count: Option<usize>,
    pub last_error: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub id: String,
    pub job_id: String,
    pub level: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryUploadSelection {
    pub count: usize,
    pub total_bytes: u64,
    pub sample_names: Vec<String>,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryUploadRequest {
    pub cloud_api_base_url: String,
    pub cloud_auth_token: Option<String>,
    pub paths: Vec<String>,
    pub source_label: Option<String>,
    pub product_image_rule_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchUploadRequest {
    pub cloud_api_base_url: Option<String>,
    pub cloud_auth_token: Option<String>,
    pub shop_ids: Vec<String>,
    pub portrait_root: String,
    pub excel_path: String,
    pub template_product: Option<Value>,
    pub max_items: Option<i64>,
    pub upload_template_video: bool,
    pub template_video_links: Vec<String>,
    #[serde(default)]
    pub auto_generate_barcode: bool,
    #[serde(default)]
    pub auto_update_stock: bool,
    #[serde(default)]
    pub auto_add_to_action: bool,
    pub auto_warehouse_id: Option<i64>,
    pub auto_stock: Option<i64>,
    pub auto_action_id: Option<i64>,
    pub auto_action_price: Option<String>,
    pub auto_action_stock: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoListingShopConfig {
    pub shop_id: String,
    pub template_product: Option<Value>,
    pub template_video_links: Vec<String>,
    pub upload_template_video: bool,
    #[serde(default)]
    pub auto_generate_barcode: bool,
    #[serde(default)]
    pub auto_update_stock: bool,
    #[serde(default)]
    pub auto_add_to_action: bool,
    pub auto_warehouse_id: Option<i64>,
    pub auto_stock: Option<i64>,
    pub auto_action_id: Option<i64>,
    pub auto_action_price: Option<String>,
    pub auto_action_stock: Option<i64>,
    pub post_listing_delay_minutes: Option<i64>,
    pub action_delay_minutes: Option<i64>,
    pub action_retry_count: Option<i64>,
    pub action_retry_interval_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoListingItem {
    pub source_asset_id: String,
    pub source_sku: String,
    pub shop_id: String,
    pub title: String,
    pub image_urls: Vec<String>,
    pub product_color: Option<String>,
    pub color_name: Option<String>,
    pub description: Option<String>,
    pub rich_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoListingRequest {
    pub batch_id: Option<String>,
    pub cloud_api_base_url: Option<String>,
    pub cloud_auth_token: Option<String>,
    pub cloud_external_shop_id_by_shop_id: Option<std::collections::HashMap<String, String>>,
    pub mockup_template_id: String,
    pub mockup_template_name: String,
    pub items: Vec<AutoListingItem>,
    pub shop_configs: Vec<AutoListingShopConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupRenderAssetInput {
    pub id: String,
    pub sku: String,
    pub source_filename: Option<String>,
    pub public_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupRenderRequest {
    pub cloud_api_base_url: Option<String>,
    pub cloud_auth_token: Option<String>,
    pub template_id: String,
    pub template_name: Option<String>,
    pub assets: Vec<LocalMockupRenderAssetInput>,
    pub max_workers: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupRenderItemResult {
    pub source_asset_id: String,
    pub source_sku: String,
    pub ok: bool,
    pub assets: Vec<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupRenderResult {
    pub ok: bool,
    pub template_id: String,
    pub template_name: String,
    pub generated: usize,
    pub success_count: usize,
    pub failed_count: usize,
    pub items: Vec<LocalMockupRenderItemResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupProgressItem {
    pub source_asset_id: String,
    pub source_sku: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMockupProgress {
    pub total: usize,
    pub worker_count: usize,
    pub started: usize,
    pub completed: usize,
    pub failed: usize,
    pub queued: usize,
    pub active: usize,
    pub running: Vec<LocalMockupProgressItem>,
    pub completed_asset_ids: Vec<String>,
    pub failed_items: Vec<LocalMockupProgressItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingImageRepairItem {
    pub batch_id: Option<String>,
    pub external_shop_id: String,
    pub shop_name: Option<String>,
    pub source_asset_id: Option<String>,
    pub source_sku: String,
    #[serde(default)]
    pub image_asset_ids: Vec<String>,
    pub image_urls: Vec<String>,
    pub uploaded_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingImageRepairRequest {
    pub cloud_api_base_url: Option<String>,
    pub cloud_auth_token: Option<String>,
    pub items: Vec<ListingImageRepairItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedUpdateRequest {
    pub shop_id: String,
    pub portrait_root: String,
    pub excel_path: String,
    pub max_items: Option<i64>,
    pub update_title: bool,
    pub update_description: bool,
    pub update_images: bool,
    pub update_video: bool,
    pub update_rich_json: bool,
    pub template_product: Option<Value>,
    pub template_video_links: Vec<String>,
    pub category_update: Option<ListedCategoryUpdateTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCategoryUpdateTarget {
    pub category_id: i64,
    pub type_id: Option<i64>,
    pub category_name: Option<String>,
    pub cached_products: Option<Vec<ListedCategoryCachedProduct>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCategoryCachedProduct {
    pub offer_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderShippingLabelAssignment {
    pub shop_id: String,
    pub order_number: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderShippingLabel {
    pub order_number: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderShippingLabelDownloadRequest {
    pub output_root: String,
    pub assignments: Vec<OrderShippingLabelAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDocumentsRequest {
    pub shop_id: String,
    pub order_numbers: Vec<String>,
    pub output_root: String,
    pub ozon_company_id: Option<String>,
    pub ozon_seller_har_path: Option<String>,
    pub ozon_seller_cookie_path: Option<String>,
    pub baidu_cookie: Option<String>,
    pub baidu_search_dir: Option<String>,
    pub baidu_recursive: bool,
    pub download_materials: bool,
    pub shipping_labels: Vec<OrderShippingLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderListRequest {
    pub shop_id: String,
    pub date_from: String,
    pub date_to: String,
    pub status: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOrderQuery {
    pub shop_ids: Option<Vec<String>>,
    pub status: Option<String>,
    pub keyword: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderPostingProduct {
    pub product_id: Option<i64>,
    pub offer_id: String,
    pub name: Option<String>,
    pub quantity: i64,
    pub price: Option<f64>,
    pub currency_code: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderPostingRow {
    pub shop_id: Option<String>,
    pub shop_name: Option<String>,
    pub posting_kind: Option<String>,
    pub posting_number: String,
    pub order_number: Option<String>,
    pub order_id: Option<i64>,
    pub status: Option<String>,
    pub in_process_at: Option<String>,
    pub shipment_date: Option<String>,
    pub warehouse_name: Option<String>,
    pub tracking_number: Option<String>,
    pub products_count: usize,
    pub offer_ids: Vec<String>,
    pub products: Option<Vec<OrderPostingProduct>>,
    pub image_url: Option<String>,
    pub sales_amount: Option<f64>,
    pub currency_code: Option<String>,
    pub synced_at: Option<String>,
    pub downloaded_at: Option<String>,
    pub download_output_path: Option<String>,
    pub raw_json: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowAutomationRequest {
    pub shop_id: String,
    pub interval_minutes: i64,
    pub max_follow_items: Option<i64>,
    #[serde(default = "default_follow_price_multiplier")]
    pub price_multiplier: f64,
    pub auto_follow_sync: bool,
    pub auto_update_stock: bool,
    pub auto_generate_barcode: bool,
    pub auto_add_to_action: bool,
    pub stock: Option<i64>,
    pub action_id: Option<i64>,
    pub action_price: Option<String>,
    pub action_stock: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingMaintenanceRequest {
    pub shop_id: String,
    pub interval_minutes: i64,
    pub auto_update_stock: bool,
    pub auto_generate_barcode: bool,
    pub auto_add_to_action: bool,
    pub warehouse_id: Option<i64>,
    pub stock: Option<i64>,
    #[serde(default)]
    pub action_configs: Vec<ListingMaintenanceActionConfig>,
}

fn default_follow_price_multiplier() -> f64 {
    3.0
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialsRequest {
    pub source_root: String,
    pub portrait_root: String,
    pub content_root: Option<String>,
    pub watermark_path: Option<String>,
    pub image_base_url: String,
    pub text_base_url: String,
    pub image_provider: String,
    pub text_provider: String,
    pub image_model: String,
    pub text_model: String,
    pub image_prompt_template: String,
    pub title_prompt_template: String,
    pub description_prompt_template: String,
    pub generate_ai_images: bool,
    pub convert_originals: bool,
    pub generate_copy: bool,
    pub export_excel: bool,
    pub max_items: Option<i64>,
    pub cloud_auth_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRenameRequest {
    pub source_root: String,
    pub output_root: String,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRenameResult {
    pub count: usize,
    pub output_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSceneRequest {
    pub source_root: String,
    pub output_root: String,
    pub mockup_root: Option<String>,
    pub single_image: Option<String>,
    pub aspect_ratio: String,
    pub scene_ids: Vec<String>,
    pub size_label: Option<String>,
    pub max_items: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OzonProductRow {
    pub product_id: Option<i64>,
    pub offer_id: String,
    pub name: String,
    pub visibility: Option<String>,
    pub has_barcode: Option<bool>,
    pub stock_summary: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub type_id: Option<i64>,
    pub type_name: Option<String>,
    pub price: Option<String>,
    pub old_price: Option<String>,
    pub currency_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductAnalyticsRow {
    pub product_id: Option<i64>,
    pub offer_id: String,
    pub name: String,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub type_id: Option<i64>,
    pub type_name: Option<String>,
    pub search_views: i64,
    pub card_views: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseOption {
    pub warehouse_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryOption {
    pub id: i64,
    pub name: String,
    pub level: usize,
    pub parent_id: Option<i64>,
    pub node_kind: String,
    pub description_category_id: Option<i64>,
    pub type_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightIssue {
    pub level: String,
    pub scope: String,
    pub message: String,
    pub action_label: Option<String>,
    pub action_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SkuImageRow {
    pub sku: String,
    pub image_count: usize,
    pub first_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewInput {
    pub template_product: Value,
    pub offer_id: String,
    pub title: String,
    pub product_color: String,
    pub product_color_dictionary_values: Vec<AttributeDictionaryValue>,
    pub color_name: String,
    pub description: String,
    pub image_urls: Vec<String>,
    pub video_links: Vec<String>,
    pub rich_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeDictionaryValue {
    pub dictionary_value_id: i64,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkuFolderReport {
    pub root: String,
    pub sku_count: usize,
    pub image_count: usize,
    pub rows: Vec<SkuFolderRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkuFolderRow {
    pub sku: String,
    pub image_count: usize,
    pub first_image: Option<String>,
}
