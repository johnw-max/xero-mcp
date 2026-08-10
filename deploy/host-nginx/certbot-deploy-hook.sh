#!/bin/sh
set -eu

# Host Nginx keeps serving the old workers if config validation fails.
nginx -t
systemctl reload nginx
