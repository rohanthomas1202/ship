#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Parse environment argument
ENV="${1:-}"
if [[ ! "$ENV" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod>"
  echo ""
  echo "Examples:"
  echo "  $0 dev     # Deploy frontend to dev environment"
  echo "  $0 prod    # Deploy frontend to prod environment"
  exit 1
fi

# Sync terraform config from SSM (source of truth)
"$SCRIPT_DIR/sync-terraform-config.sh" "$ENV"

echo "=========================================="
echo "Ship - Frontend Deployment ($ENV)"
echo "=========================================="
echo ""

# Navigate to project root
cd "$PROJECT_ROOT"

# All environments use the modular terraform structure
TF_DIR="$PROJECT_ROOT/terraform/environments/$ENV"

# Get S3 bucket name and CloudFront distribution ID from Terraform
BUCKET_NAME=$(cd "$TF_DIR" && terraform output -raw s3_bucket_name)
DISTRIBUTION_ID=$(cd "$TF_DIR" && terraform output -raw cloudfront_distribution_id)
FRONTEND_URL=$(cd "$TF_DIR" && terraform output -raw frontend_url)

if [ -z "$BUCKET_NAME" ] || [ -z "$DISTRIBUTION_ID" ]; then
    echo "Error: Could not get infrastructure details from Terraform"
    echo "Make sure you've deployed infrastructure first: ./scripts/deploy-infrastructure.sh"
    exit 1
fi

echo "Building shared package..."
pnpm build:shared

echo ""
echo "Building frontend..."
VITE_APP_ENV=production pnpm build:web

echo ""
echo "Deploying to S3 bucket: $BUCKET_NAME"
aws s3 sync web/dist/ "s3://${BUCKET_NAME}" --delete --cache-control "public,max-age=31536000,immutable"

# Upload index.html separately with shorter cache for SPA routing
aws s3 cp web/dist/index.html "s3://${BUCKET_NAME}/index.html" --cache-control "public,max-age=300"

echo ""
echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"

echo ""
echo "=========================================="
echo "Frontend deployment complete!"
echo "=========================================="
echo ""
echo "Frontend URL: $FRONTEND_URL"
echo ""
echo "Note: CloudFront invalidation may take 1-2 minutes to complete"
