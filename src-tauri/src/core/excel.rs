use anyhow::Result;
use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRow {
    pub sku: String,
    pub title: String,
    pub product_color: String,
    pub color_name: String,
    pub description: String,
    pub rich_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResultRow {
    pub sku: String,
    pub title: String,
    pub image_count: usize,
    pub status: String,
    pub uploaded_sku: String,
    pub task_id: String,
    pub oss_folder: String,
    pub error: String,
}

pub fn create_upload_template(path: &Path) -> Result<()> {
    write_upload_rows(
        path,
        &[ContentRow {
            sku: "SKU001".into(),
            title: "2 штуки в упаковке，Повязка на голову женская".into(),
            product_color: String::new(),
            color_name: String::new(),
            description: String::new(),
            rich_json: String::new(),
        }],
    )
}

pub fn write_upload_rows(path: &Path, rows: &[ContentRow]) -> Result<()> {
    let mut workbook = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xEAF3FF));
    let wrap = Format::new().set_text_wrap();

    let sheet = workbook.add_worksheet();
    sheet.set_name("Sheet1")?;
    let headers = [
        "货号",
        "标题",
        "商品颜色",
        "颜色名称(俄语)",
        "商品ID",
        "英文标题",
        "子目录",
    ];
    for (index, header) in headers.iter().enumerate() {
        sheet.write_with_format(0, index as u16, *header, &header_format)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        let r = (row_index + 1) as u32;
        sheet.write_with_format(r, 0, &row.sku, &wrap)?;
        sheet.write_with_format(r, 1, &row.title, &wrap)?;
        sheet.write_with_format(r, 2, &row.product_color, &wrap)?;
        sheet.write_with_format(r, 3, &row.color_name, &wrap)?;
    }
    sheet.set_freeze_panes(1, 0)?;
    sheet.set_column_width(0, 18)?;
    sheet.set_column_width(1, 48)?;
    sheet.set_column_width(2, 18)?;
    sheet.set_column_width(3, 18)?;
    sheet.set_column_width(4, 18)?;
    sheet.set_column_width(5, 48)?;
    sheet.set_column_width(6, 18)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    workbook.save(path)?;
    Ok(())
}

pub fn read_content_rows(path: &Path) -> Result<Vec<ContentRow>> {
    let mut workbook = open_workbook_auto(path)?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Excel 文件没有工作表"))?;
    let range = workbook.worksheet_range(&sheet_name)?;
    let mut rows = range.rows();
    let headers = rows
        .next()
        .ok_or_else(|| anyhow::anyhow!("Excel 缺少表头"))?
        .iter()
        .map(cell_text)
        .collect::<Vec<_>>();

    let sku_idx = header_index(&headers, &["货号", "sku", "offer_id"])?;
    let title_idx = header_index(&headers, &["标题", "title", "name"])?;
    let product_color_idx = optional_header_index(&headers, &["商品颜色", "颜色", "product_color"]);
    let color_name_idx = optional_header_index(
        &headers,
        &[
            "颜色名称(俄语)",
            "颜色名称",
            "俄语颜色",
            "color_name",
            "color_name_ru",
        ],
    );
    let desc_idx = optional_header_index(&headers, &["简介", "描述", "description"]);
    let rich_idx = optional_header_index(
        &headers,
        &["json富文本内容", "json富内容", "富文本json", "rich_json"],
    );

    let mut result = Vec::new();
    for row in rows {
        let sku = cell_at(row, sku_idx);
        if sku.is_empty() {
            continue;
        }
        result.push(ContentRow {
            sku,
            title: cell_at(row, title_idx),
            product_color: product_color_idx
                .map(|idx| cell_at(row, idx))
                .unwrap_or_default(),
            color_name: color_name_idx
                .map(|idx| cell_at(row, idx))
                .unwrap_or_default(),
            description: desc_idx.map(|idx| cell_at(row, idx)).unwrap_or_default(),
            rich_json: rich_idx.map(|idx| cell_at(row, idx)).unwrap_or_default(),
        });
    }
    Ok(result)
}

pub fn read_sku_rows(path: &Path) -> Result<Vec<ContentRow>> {
    let mut workbook = open_workbook_auto(path)?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Excel 文件没有工作表"))?;
    let range = workbook.worksheet_range(&sheet_name)?;
    let mut rows = range.rows();
    let headers = rows
        .next()
        .ok_or_else(|| anyhow::anyhow!("Excel 缺少表头"))?
        .iter()
        .map(cell_text)
        .collect::<Vec<_>>();

    let sku_idx = header_index(&headers, &["货号", "sku", "offer_id"])?;
    let title_idx = optional_header_index(&headers, &["标题", "title", "name"]);
    let product_color_idx = optional_header_index(&headers, &["商品颜色", "颜色", "product_color"]);
    let color_name_idx = optional_header_index(
        &headers,
        &[
            "颜色名称(俄语)",
            "颜色名称",
            "俄语颜色",
            "color_name",
            "color_name_ru",
        ],
    );
    let desc_idx = optional_header_index(&headers, &["简介", "描述", "description"]);
    let rich_idx = optional_header_index(
        &headers,
        &["json富文本内容", "json富内容", "富文本json", "rich_json"],
    );

    let mut result = Vec::new();
    for row in rows {
        let sku = cell_at(row, sku_idx);
        if sku.is_empty() {
            continue;
        }
        result.push(ContentRow {
            sku,
            title: title_idx.map(|idx| cell_at(row, idx)).unwrap_or_default(),
            product_color: product_color_idx
                .map(|idx| cell_at(row, idx))
                .unwrap_or_default(),
            color_name: color_name_idx
                .map(|idx| cell_at(row, idx))
                .unwrap_or_default(),
            description: desc_idx.map(|idx| cell_at(row, idx)).unwrap_or_default(),
            rich_json: rich_idx.map(|idx| cell_at(row, idx)).unwrap_or_default(),
        });
    }
    Ok(result)
}

pub fn write_batch_results(path: &Path, rows: &[BatchResultRow]) -> Result<()> {
    let mut workbook = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xEAF3FF));
    let error_format = Format::new()
        .set_text_wrap()
        .set_background_color(Color::RGB(0xFFF2F0));
    let ok_format = Format::new().set_text_wrap();
    let sheet = workbook.add_worksheet();
    sheet.set_name("批量处理结果")?;
    let headers = [
        "货号",
        "标题",
        "图片数量",
        "状态",
        "上传成功SKU",
        "Ozon task_id",
        "OSS 文件夹",
        "错误信息",
    ];
    for (index, header) in headers.iter().enumerate() {
        sheet.write_with_format(0, index as u16, *header, &header_format)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        let r = (row_index + 1) as u32;
        let format = if row.status == "失败" {
            &error_format
        } else {
            &ok_format
        };
        sheet.write_with_format(r, 0, &row.sku, format)?;
        sheet.write_with_format(r, 1, &row.title, format)?;
        sheet.write_with_format(r, 2, row.image_count as u32, format)?;
        sheet.write_with_format(r, 3, &row.status, format)?;
        sheet.write_with_format(r, 4, &row.uploaded_sku, format)?;
        sheet.write_with_format(r, 5, &row.task_id, format)?;
        sheet.write_with_format(r, 6, &row.oss_folder, format)?;
        sheet.write_with_format(r, 7, &row.error, format)?;
    }
    sheet.set_freeze_panes(1, 0)?;
    for (index, width) in [22.0, 42.0, 12.0, 14.0, 22.0, 24.0, 48.0, 72.0]
        .iter()
        .enumerate()
    {
        sheet.set_column_width(index as u16, *width)?;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    workbook.save(path)?;
    Ok(())
}

pub fn write_status_to_source_excel(path: &Path, results: &[BatchResultRow]) -> Result<()> {
    let mut workbook_in = open_workbook_auto(path)?;
    let sheet_name = workbook_in
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Excel 文件没有工作表"))?;
    let range = workbook_in.worksheet_range(&sheet_name)?;
    let mut rows = range
        .rows()
        .map(|row| row.iter().map(cell_text).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        anyhow::bail!("Excel 缺少表头");
    }

    let mut headers = rows[0].clone();
    for header in [
        "是否上传成功",
        "上传成功SKU",
        "Ozon task_id",
        "OSS 文件夹",
        "错误信息",
    ] {
        if !headers.iter().any(|value| value == header) {
            headers.push(header.to_string());
        }
    }
    let sku_idx = optional_header_index(&headers, &["货号", "sku", "offer_id"])
        .ok_or_else(|| anyhow::anyhow!("Excel 缺少表头: 货号"))?;
    let success_idx = header_index(&headers, &["是否上传成功"])?;
    let uploaded_idx = header_index(&headers, &["上传成功SKU"])?;
    let task_idx = header_index(&headers, &["Ozon task_id"])?;
    let oss_idx = header_index(&headers, &["OSS 文件夹"])?;
    let error_idx = header_index(&headers, &["错误信息"])?;
    rows[0] = headers;

    let result_by_sku = results
        .iter()
        .map(|row| (row.sku.trim().to_string(), row))
        .collect::<std::collections::HashMap<_, _>>();
    let output_width = rows[0].len();
    for row in rows.iter_mut().skip(1) {
        row.resize(output_width, String::new());
        let sku = row.get(sku_idx).cloned().unwrap_or_default();
        let Some(result) = result_by_sku.get(sku.trim()) else {
            continue;
        };
        row[success_idx] = if result.status == "已提交" {
            "是"
        } else {
            "否"
        }
        .into();
        row[uploaded_idx] = result.uploaded_sku.clone();
        row[task_idx] = result.task_id.clone();
        row[oss_idx] = result.oss_folder.clone();
        row[error_idx] = result.error.clone();
    }

    let mut workbook_out = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xEAF3FF));
    let wrap = Format::new().set_text_wrap();
    let sheet = workbook_out.add_worksheet();
    sheet.set_name(&sheet_name)?;
    for (row_index, row) in rows.iter().enumerate() {
        for (col_index, value) in row.iter().enumerate() {
            if row_index == 0 {
                sheet.write_with_format(
                    row_index as u32,
                    col_index as u16,
                    value,
                    &header_format,
                )?;
            } else {
                sheet.write_with_format(row_index as u32, col_index as u16, value, &wrap)?;
            }
        }
    }
    sheet.set_freeze_panes(1, 0)?;
    for (index, width) in [20.0, 48.0, 82.0, 36.0, 18.0, 24.0, 24.0, 48.0, 72.0]
        .iter()
        .enumerate()
    {
        sheet.set_column_width(index as u16, *width)?;
    }
    workbook_out.save(path)?;
    Ok(())
}

fn header_index(headers: &[String], candidates: &[&str]) -> Result<usize> {
    optional_header_index(headers, candidates)
        .ok_or_else(|| anyhow::anyhow!("Excel 缺少表头: {}", candidates[0]))
}

fn optional_header_index(headers: &[String], candidates: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = header.trim().to_lowercase();
        candidates
            .iter()
            .any(|candidate| normalized == candidate.to_lowercase())
    })
}

fn cell_at(row: &[Data], index: usize) -> String {
    row.get(index).map(cell_text).unwrap_or_default()
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.trim().to_string(),
        Data::Float(value) if value.fract() == 0.0 => format!("{value:.0}"),
        Data::Float(value) => value.to_string(),
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) | Data::DurationIso(value) => value.trim().to_string(),
        Data::Error(value) => format!("{value:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_upload_template_matches_simple_five_column_format() {
        let path = std::env::temp_dir().join(format!(
            "ozon-upload-template-{}.xlsx",
            uuid::Uuid::new_v4()
        ));
        create_upload_template(&path).unwrap();

        let rows = read_content_rows(&path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sku, "SKU001");
        assert!(!rows[0].title.is_empty());
        assert!(rows[0].description.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn writes_generated_titles_as_upload_excel_rows() {
        let path =
            std::env::temp_dir().join(format!("ozon-title-rows-{}.xlsx", uuid::Uuid::new_v4()));
        write_upload_rows(
            &path,
            &[ContentRow {
                sku: "image-001".into(),
                title: "Generated title".into(),
                product_color: "米色".into(),
                color_name: "бежевый".into(),
                description: String::new(),
                rich_json: String::new(),
            }],
        )
        .unwrap();

        let rows = read_content_rows(&path).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sku, "image-001");
        assert_eq!(rows[0].title, "Generated title");
        assert_eq!(rows[0].product_color, "米色");
        assert_eq!(rows[0].color_name, "бежевый");

        let _ = std::fs::remove_file(path);
    }
}
