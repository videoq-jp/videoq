# Database contents never share the executable-bundle bucket. No routine reader,
# delete permission, expiration or public access is added by this configuration.
resource "aws_s3_bucket" "archive" {
  count         = var.retain_verified_backups ? 1 : 0
  bucket        = "videoq-db-archives-prod-${local.account}"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "archive" {
  count                   = var.retain_verified_backups ? 1 : 0
  bucket                  = aws_s3_bucket.archive[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "archive" {
  count  = var.retain_verified_backups ? 1 : 0
  bucket = aws_s3_bucket.archive[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_versioning" "archive" {
  count  = var.retain_verified_backups ? 1 : 0
  bucket = aws_s3_bucket.archive[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  count  = var.retain_verified_backups ? 1 : 0
  bucket = aws_s3_bucket.archive[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "archive" {
  count  = var.retain_verified_backups ? 1 : 0
  bucket = aws_s3_bucket.archive[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect   = "Deny", Principal = "*", Action = "s3:*",
      Resource = [aws_s3_bucket.archive[0].arn, "${aws_s3_bucket.archive[0].arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    { Effect   = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource = "${aws_s3_bucket.archive[0].arn}/*",
    Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "AES256" } } },
    { Effect   = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource = "${aws_s3_bucket.archive[0].arn}/*",
    Condition = { Null = { "s3:if-none-match" = "true" } } }
  ] })
}
