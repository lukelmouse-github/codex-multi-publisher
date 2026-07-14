# Project-local non-secret WeChat preferences.
# Keep app_id/app_secret out of this file. Use account-prefixed environment
# variables or the ignored .baoyu-skills/.env file.

default_theme: default
default_publish_method: api

accounts:
  - name: Example Account
    alias: example-account
    default: true
    default_publish_method: api
    default_author: Example Author
    need_open_comment: 1
    only_fans_can_comment: 0
