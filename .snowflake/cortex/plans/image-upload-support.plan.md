# Plan: Image Upload Support for Pipeline

## Context

The `/pipeline/upload` page currently only accepts `.txt` files. The user wants to add image support (PNG, JPG, JPEG, WEBP) so screenshots of paste dumps or leaked data can be uploaded and processed by the pipeline.

The downstream pipeline expects plain text in `RAW_TEXT`. We'll use Snowflake Cortex `AI_COMPLETE` with vision capability to extract text from uploaded images before the existing pipeline stages consume it.

## Architecture

```
Image file → Frontend → API → base64 encode → JSONL on GCS → COPY INTO CRAWL_PAGES
                                                                       ↓
                                                          DT_IMAGE_TEXT_EXTRACTION
                                                          (AI_COMPLETE vision → RAW_TEXT)
                                                                       ↓
                                                          DT_REGEX_INDICATORS (unchanged)
                                                                       ↓
                                                              ... rest of pipeline
```

## Changes

### 1. Update validation (`src/lib/manual-upload.ts`)

- Accept `.txt`, `.png`, `.jpg`, `.jpeg`, `.webp`
- Keep the 5 MB limit (reasonable for images)
- Export a helper `isImageUpload(file: File): boolean` for conditional logic

### 2. Handle binary in API route (`src/app/api/manual-uploads/route.ts`)

- For image files: read as `ArrayBuffer`, base64-encode, store in `image_base64` field of the JSONL record
- Set `raw_text` to `"[image — pending OCR extraction]"` as a placeholder
- Add `content_type` field to the record (e.g. `"image/png"`)

### 3. Snowflake schema change

- Add `IMAGE_BASE64 STRING` (nullable) and `CONTENT_TYPE STRING` (nullable) to `CRAWL_PAGES`
- Update the `COPY INTO` in `copyManualUploadObject()` to include these new columns

### 4. Vision extraction dynamic table

New SQL file: `snowflake/04_dt_image_text_extraction.sql`

```sql
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.PIPELINE.DT_IMAGE_TEXT_EXTRACTION
  TARGET_LAG = '1 minute'
  WAREHOUSE = NOCTURNE_PIPELINE_WH
AS
SELECT
  *  EXCLUDE (RAW_TEXT, IMAGE_BASE64),
  CASE
    WHEN IMAGE_BASE64 IS NOT NULL THEN
      AI_COMPLETE('claude-sonnet-4-5',
        'Extract all visible text from this image verbatim. Return only the extracted text, no commentary.',
        TO_VARIANT(OBJECT_CONSTRUCT(
          'type', 'image',
          'source', OBJECT_CONSTRUCT('type', 'base64', 'media_type', CONTENT_TYPE, 'data', IMAGE_BASE64)
        ))
      )
    ELSE RAW_TEXT
  END AS RAW_TEXT
FROM NOCTURNE.RAW.CRAWL_PAGES;
```

Then update `DT_REGEX_INDICATORS` to read from `DT_IMAGE_TEXT_EXTRACTION` instead of `CRAWL_PAGES` directly.

**Note:** The exact `AI_COMPLETE` vision syntax will need verification against Snowflake docs — the multimodal message format may differ. I'll confirm during implementation.

### 5. Frontend updates (`pipeline/upload/page.tsx`)

- Update `accept` attribute: `.txt,.png,.jpg,.jpeg,.webp,text/plain,image/png,image/jpeg,image/webp`
- Show image thumbnail preview when an image is selected
- Update the dropzone helper text to indicate accepted formats

## Considerations

- **Size limit:** 5 MB is fine for images — base64 encoding inflates ~33%, so the JSONL payload will be ~6.7 MB max, which is within GCS/Snowflake limits
- **DT_REGEX_INDICATORS dependency:** Needs to change its source from `CRAWL_PAGES` to the new extraction DT. This means existing text uploads also flow through the new DT (they pass through unchanged, so no behavioral difference)
- **No crawler changes:** This only affects manual uploads — the crawler already extracts text from HTML and doesn't download images
