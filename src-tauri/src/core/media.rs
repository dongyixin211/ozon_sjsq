use crate::core::ai::{CopyPayload, OpenAiCompatibleClient};
use crate::core::business::list_sku_images;
use crate::core::jobs::JobRegistry;
use crate::core::models::{JobStatus, LocalSceneRequest, MaterialsRequest};
use crate::core::secrets;
use anyhow::{Context, Result};
use image::imageops::{self, FilterType};
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba, RgbaImage};
use std::path::{Path, PathBuf};

const DEFAULT_PORTRAIT_SIZE: (u32, u32) = (1200, 1600);

pub async fn run_materials_job(jobs: JobRegistry, job_id: String, request: MaterialsRequest) {
    if let Err(error) = materials_inner(&jobs, &job_id, request).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

pub async fn run_local_scene_job(jobs: JobRegistry, job_id: String, request: LocalSceneRequest) {
    if let Err(error) = local_scene_inner(&jobs, &job_id, request).await {
        jobs.log(&job_id, "error", &error.to_string());
        jobs.fail(&job_id, error.to_string());
    }
}

async fn materials_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: MaterialsRequest,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let source_root = PathBuf::from(&request.source_root);
    let portrait_root = PathBuf::from(&request.portrait_root);
    if !source_root.is_dir() {
        anyhow::bail!("源目录不存在: {}", source_root.display());
    }
    if portrait_root.as_os_str().is_empty() {
        anyhow::bail!("3:4 输出目录不能为空");
    }
    let mut items = collect_sku_images(&source_root)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        items.truncate(max_items as usize);
    }
    if items.is_empty() {
        anyhow::bail!("源目录下没有可处理图片");
    }
    jobs.log(job_id, "info", &format!("发现 {} 张图片", items.len()));

    let watermark = request
        .watermark_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let image_client = if request.generate_ai_images {
        let key = secrets::get_secret(&secrets::provider_api_key_id(
            "image",
            &request.image_provider,
        ))
        .context("未找到图片 provider API Key，请先在设置中保存")?;
        Some(OpenAiCompatibleClient::new(&request.image_base_url, key)?)
    } else {
        None
    };
    let text_client = if request.generate_copy {
        let key = secrets::get_secret(&secrets::provider_api_key_id(
            "text",
            &request.text_provider,
        ))
        .context("未找到文案 provider API Key，请先在设置中保存")?;
        Some(OpenAiCompatibleClient::new(&request.text_base_url, key)?)
    } else {
        None
    };
    for (index, (sku, image_path)) in items.iter().enumerate() {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "素材生成已取消");
            return Ok(());
        }
        if let Some(client) = &image_client {
            let output = portrait_root.join(sku).join(format!(
                "{}_ai_vertical.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image")
            ));
            let prompt =
                render_prompt(&request.image_prompt_template, sku, &[image_path.as_path()]);
            client
                .generate_image_from_reference(
                    &request.image_model,
                    &prompt,
                    Some(image_path),
                    &output,
                )
                .await?;
            jobs.log(
                job_id,
                "info",
                &format!("已生成 AI 图片: {}", output.display()),
            );
        }
        if request.convert_originals {
            let output = portrait_root.join(sku).join(format!(
                "{}_3x4.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image")
            ));
            create_portrait_variant(
                image_path,
                &output,
                DEFAULT_PORTRAIT_SIZE,
                watermark.as_deref(),
            )?;
            jobs.log(
                job_id,
                "info",
                &format!("已生成 3:4 图片: {}", output.display()),
            );
        }
        if let Some(client) = &text_client {
            let title_prompt =
                render_prompt(&request.title_prompt_template, sku, &[image_path.as_path()]);
            let description_prompt = render_prompt(
                &request.description_prompt_template,
                sku,
                &[image_path.as_path()],
            );
            let title = client
                .generate_title(&request.text_model, &title_prompt)
                .await
                .unwrap_or_default();
            let mut copy = client
                .generate_copy(&request.text_model, &description_prompt)
                .await?;
            if copy.title.trim().is_empty() {
                copy.title = title;
            }
            write_copy_files(request.content_root.as_deref(), sku, &copy)?;
            jobs.log(job_id, "info", &format!("已生成文案: {sku}"));
        } else if request.generate_copy {
            write_copy_stub(request.content_root.as_deref(), sku)?;
        }
        let progress = (((index + 1) * 100) / items.len()).clamp(1, 99) as u8;
        jobs.update(job_id, JobStatus::Running, progress, None);
    }
    jobs.complete_with_output(job_id, Some(request.portrait_root));
    Ok(())
}

async fn local_scene_inner(
    jobs: &JobRegistry,
    job_id: &str,
    request: LocalSceneRequest,
) -> Result<()> {
    jobs.update(job_id, JobStatus::Running, 1, None);
    let source_root = PathBuf::from(&request.source_root);
    let output_root = PathBuf::from(&request.output_root);
    if !source_root.is_dir() {
        anyhow::bail!("源目录不存在: {}", source_root.display());
    }
    let mut items = collect_sku_images(&source_root)?;
    if let Some(max_items) = request.max_items.filter(|value| *value > 0) {
        items.truncate(max_items as usize);
    }
    if items.is_empty() {
        anyhow::bail!("源目录下没有可处理图片");
    }
    let scenes = if request.scene_ids.is_empty() {
        vec!["flat_full".to_string()]
    } else {
        request.scene_ids.clone()
    };
    let mockup_root = request
        .mockup_root
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let canvas_size = parse_canvas_size(&request.aspect_ratio);
    let total = items.len() * scenes.len();
    let mut done = 0usize;
    for (sku, image_path) in &items {
        if jobs.is_cancelled(job_id) {
            jobs.log(job_id, "warn", "本地场景图任务已取消");
            return Ok(());
        }
        let product = image::open(image_path)
            .with_context(|| format!("无法打开图片 {}", image_path.display()))?;
        for scene_id in &scenes {
            let scene = render_scene(
                &product,
                canvas_size,
                scene_id,
                mockup_root.as_deref(),
                request.size_label.as_deref().unwrap_or(""),
            )?;
            let output = output_root.join(sku).join(format!(
                "{}_{}.png",
                image_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("image"),
                scene_id
            ));
            save_png(&scene, &output)?;
            jobs.log(
                job_id,
                "info",
                &format!("已生成场景图: {}", output.display()),
            );
            done += 1;
            let progress = ((done * 100) / total.max(1)).clamp(1, 99) as u8;
            jobs.update(job_id, JobStatus::Running, progress, None);
        }
    }
    jobs.complete_with_output(job_id, Some(request.output_root));
    Ok(())
}

pub fn create_portrait_variant(
    source_path: &Path,
    destination_path: &Path,
    size: (u32, u32),
    watermark_path: Option<&Path>,
) -> Result<()> {
    let original = image::open(source_path)
        .with_context(|| format!("无法打开图片 {}", source_path.display()))?;
    let foreground = original
        .resize(size.0, size.1, FilterType::Lanczos3)
        .to_rgba8();
    let background = cover_resize(&original, size)
        .blur(18.0)
        .grayscale()
        .to_rgba8();
    let mut canvas = background;
    let x = ((size.0 as i64 - foreground.width() as i64) / 2).max(0) as i64;
    let y = ((size.1 as i64 - foreground.height() as i64) / 2).max(0) as i64;
    imageops::overlay(&mut canvas, &foreground, x, y);
    if let Some(watermark_path) = watermark_path {
        apply_watermark(&mut canvas, watermark_path)?;
    }
    save_png(&DynamicImage::ImageRgba8(canvas), destination_path)
}

fn render_scene(
    product: &DynamicImage,
    canvas_size: (u32, u32),
    scene_id: &str,
    mockup_root: Option<&Path>,
    size_label: &str,
) -> Result<DynamicImage> {
    let mut canvas = if let Some(mockup) = find_mockup(mockup_root, scene_id) {
        cover_resize(
            &image::open(&mockup).with_context(|| format!("无法打开模板 {}", mockup.display()))?,
            canvas_size,
        )
        .to_rgba8()
    } else {
        white_canvas(canvas_size)
    };
    match scene_id {
        "dual" | "headscarf_side" | "headscarf_back" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.05, 0.14, 0.46, 0.84),
                -10.0,
            );
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.50, 0.08, 0.95, 0.92),
                5.0,
            );
        }
        "stack" | "bow_and_fold" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.08, 0.20, 0.64, 0.82),
                -12.0,
            );
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.32, 0.12, 0.94, 0.88),
                7.0,
            );
        }
        "size_chart" => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.10, 0.08, 0.90, 0.76),
                0.0,
            );
            draw_simple_label(&mut canvas, size_label);
        }
        _ => {
            paste_fit(
                &mut canvas,
                product,
                rect(canvas_size, 0.08, 0.08, 0.92, 0.92),
                0.0,
            );
        }
    }
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn collect_sku_images(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut result = Vec::new();
    for entry in root.read_dir()? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            let sku = entry.file_name().to_string_lossy().to_string();
            for image in list_sku_images(&path)? {
                result.push((sku.clone(), image));
            }
        }
    }
    if result.is_empty() {
        for image in list_sku_images(root)? {
            let sku = image
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("sku")
                .to_string();
            result.push((sku, image));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(result)
}

fn cover_resize(image: &DynamicImage, size: (u32, u32)) -> DynamicImage {
    let (target_w, target_h) = size;
    let (w, h) = image.dimensions();
    let scale = (target_w as f32 / w as f32).max(target_h as f32 / h as f32);
    let resized_w = (w as f32 * scale).ceil() as u32;
    let resized_h = (h as f32 * scale).ceil() as u32;
    let resized = image.resize(resized_w, resized_h, FilterType::Lanczos3);
    let x = resized_w.saturating_sub(target_w) / 2;
    let y = resized_h.saturating_sub(target_h) / 2;
    resized.crop_imm(x, y, target_w, target_h)
}

fn paste_fit(
    canvas: &mut RgbaImage,
    product: &DynamicImage,
    area: (u32, u32, u32, u32),
    rotate_deg: f32,
) {
    let (x0, y0, x1, y1) = area;
    let max_w = x1.saturating_sub(x0).max(1);
    let max_h = y1.saturating_sub(y0).max(1);
    let mut layer = product.resize(max_w, max_h, FilterType::Lanczos3);
    if rotate_deg.abs() > f32::EPSILON {
        layer = rotate_nearest_90(layer, rotate_deg);
    }
    let rgba = layer.to_rgba8();
    let x = x0 as i64 + ((max_w as i64 - rgba.width() as i64) / 2).max(0);
    let y = y0 as i64 + ((max_h as i64 - rgba.height() as i64) / 2).max(0);
    imageops::overlay(canvas, &rgba, x, y);
}

fn rotate_nearest_90(image: DynamicImage, rotate_deg: f32) -> DynamicImage {
    if rotate_deg > 45.0 {
        image.rotate90()
    } else if rotate_deg < -45.0 {
        image.rotate270()
    } else {
        image
    }
}

fn apply_watermark(canvas: &mut RgbaImage, watermark_path: &Path) -> Result<()> {
    let watermark = image::open(watermark_path)
        .with_context(|| format!("无法打开水印 {}", watermark_path.display()))?
        .to_rgba8();
    let max_width = (canvas.width() as f32 * 0.18).max(1.0) as u32;
    let watermark = if watermark.width() > max_width {
        let ratio = max_width as f32 / watermark.width() as f32;
        imageops::resize(
            &watermark,
            max_width,
            (watermark.height() as f32 * ratio).max(1.0) as u32,
            FilterType::Lanczos3,
        )
    } else {
        watermark
    };
    let margin = 36u32;
    let x = canvas
        .width()
        .saturating_sub(watermark.width())
        .saturating_sub(margin) as i64;
    let y = canvas
        .height()
        .saturating_sub(watermark.height())
        .saturating_sub(margin) as i64;
    imageops::overlay(canvas, &watermark, x, y);
    Ok(())
}

fn white_canvas(size: (u32, u32)) -> RgbaImage {
    ImageBuffer::from_pixel(size.0, size.1, Rgba([255, 255, 255, 255]))
}

fn rect(size: (u32, u32), x0: f32, y0: f32, x1: f32, y1: f32) -> (u32, u32, u32, u32) {
    (
        (size.0 as f32 * x0) as u32,
        (size.1 as f32 * y0) as u32,
        (size.0 as f32 * x1) as u32,
        (size.1 as f32 * y1) as u32,
    )
}

fn draw_simple_label(canvas: &mut RgbaImage, label: &str) {
    if label.trim().is_empty() {
        return;
    }
    let y = (canvas.height() as f32 * 0.84) as u32;
    let x0 = (canvas.width() as f32 * 0.16) as u32;
    let x1 = (canvas.width() as f32 * 0.84) as u32;
    for x in x0..x1 {
        for dy in 0..3 {
            if y + dy < canvas.height() {
                canvas.put_pixel(x, y + dy, Rgba([60, 70, 82, 255]));
            }
        }
    }
}

fn find_mockup(mockup_root: Option<&Path>, scene_id: &str) -> Option<PathBuf> {
    let root = mockup_root?;
    [
        root.join(format!("{scene_id}.jpg")),
        root.join(format!("{scene_id}.png")),
        root.join(format!("{scene_id}.jpeg")),
        root.join(format!("{scene_id}.webp")),
        root.join(scene_id).join("base.jpg"),
        root.join(scene_id).join("base.png"),
        root.join(scene_id).join("mockup.jpg"),
        root.join(scene_id).join("mockup.png"),
        root.join(scene_id).join("left.jpg"),
        root.join(scene_id).join("left.png"),
        root.join("_default.jpg"),
        root.join("_default.png"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn parse_canvas_size(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim().replace('：', ":").as_str() {
        "1:1" => (1200, 1200),
        "4:3" => (1600, 1200),
        "16:9" => (1600, 900),
        "2:3" => (1200, 1800),
        "9:16" => (1080, 1920),
        _ => DEFAULT_PORTRAIT_SIZE,
    }
}

fn save_png(image: &DynamicImage, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    image.save(path)?;
    Ok(())
}

fn write_copy_stub(content_root: Option<&str>, sku: &str) -> Result<()> {
    let Some(content_root) = content_root.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let dir = PathBuf::from(content_root).join(sku);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::json!({
        "sku": sku,
        "title": "",
        "description": "",
        "bullets": []
    });
    std::fs::write(
        dir.join(format!("{sku}_content.json")),
        serde_json::to_string_pretty(&json)?,
    )?;
    std::fs::write(
        dir.join(format!("{sku}_content.txt")),
        "标题：\n\n描述：\n\n卖点：\n",
    )?;
    Ok(())
}

fn write_copy_files(content_root: Option<&str>, sku: &str, payload: &CopyPayload) -> Result<()> {
    let Some(content_root) = content_root.filter(|value| !value.trim().is_empty()) else {
        anyhow::bail!("文案输出目录不能为空");
    };
    let dir = PathBuf::from(content_root).join(sku);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::json!({
        "sku": sku,
        "title": payload.title,
        "description": payload.description,
        "bullets": payload.bullets
    });
    std::fs::write(
        dir.join(format!("{sku}_content.json")),
        serde_json::to_string_pretty(&json)?,
    )?;
    let mut lines = vec![
        format!("标题：{}", payload.title),
        String::new(),
        "描述：".into(),
        payload.description.clone(),
        String::new(),
        "卖点：".into(),
    ];
    for (index, bullet) in payload.bullets.iter().enumerate() {
        lines.push(format!("{}. {}", index + 1, bullet));
    }
    std::fs::write(dir.join(format!("{sku}_content.txt")), lines.join("\n"))?;
    Ok(())
}

fn render_prompt(template: &str, sku: &str, images: &[&Path]) -> String {
    let image_names = images
        .iter()
        .filter_map(|path| path.file_name().and_then(|s| s.to_str()))
        .collect::<Vec<_>>()
        .join(", ");
    template
        .replace("{sku}", sku)
        .replace("{folder_name}", sku)
        .replace("{image_count}", &images.len().to_string())
        .replace("{image_names}", &image_names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_canvas_sizes() {
        assert_eq!(parse_canvas_size("1:1"), (1200, 1200));
        assert_eq!(parse_canvas_size("3:4"), (1200, 1600));
    }

    #[test]
    fn no_mockup_without_root() {
        assert!(find_mockup(None, "flat_full").is_none());
    }
}
