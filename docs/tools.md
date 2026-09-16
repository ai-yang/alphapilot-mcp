# 工具映射

由固定注册表生成；可选保存、刷新数据等参数还需要额外权限。

| 工具 | 组 | HTTP 映射 | 基本权限 |
|---|---|---|---|
| get_capabilities | core | GET /api/v1/capabilities | research:read |
| get_status | core | GET /api/v1/status | research:read |
| list_datasets | core | GET /api/v1/datasets | research:read |
| list_templates | core | GET /api/v1/templates | research:read |
| list_models | core | GET /api/v1/models | research:read |
| get_factor_dsl | core | GET /api/v1/factor-dsl | research:read |
| list_symbols | core | GET /api/v1/datasets/{dataset_id}/symbols | research:read |
| get_market_bars | core | GET /api/v1/datasets/{dataset_id}/bars | research:read |
| list_jobs | core | GET /api/v1/jobs | research:read |
| get_job | core | GET /api/v1/jobs/{job_id} | research:read |
| get_job_logs | core | GET /api/v1/jobs/{job_id}/logs | research:read |
| get_job_result | core | GET /api/v1/jobs/{job_id}/result | research:read |
| list_runs | core | GET /api/v1/runs | research:read |
| get_run | core | GET /api/v1/runs/{run_id} | research:read |
| list_artifacts | core | GET /api/v1/artifacts | research:read |
| get_artifact | core | GET /api/v1/artifacts/{artifact_id} | research:read |
| get_artifact_table | core | GET /api/v1/artifacts/{artifact_id}/table | research:read |
| get_artifact_series | core | GET /api/v1/artifacts/{artifact_id}/series | research:read |
| list_factor_categories | core | GET /api/v1/factors/categories | research:read |
| find_duplicate_factors | core | GET /api/v1/factors/duplicates | research:read |
| validate_factors | core | POST /api/v1/factors/validate | research:read |
| cancel_job | core | POST /api/v1/jobs/{job_id}/cancel | research:read, jobs:cancel |
| list_factors | core | GET /api/v1/factors | research:read |
| get_factor | core | GET /api/v1/factors/{key} | research:read |
| create_factor | core | POST /api/v1/factors | research:read, research:write |
| update_factor | core | PATCH /api/v1/factors/{key} | research:read, research:write |
| delete_factor | cleanup | DELETE /api/v1/factors/{key} | research:read, research:write |
| export_factors | files | POST /api/v1/factors/export | research:read |
| import_factors | files | POST /api/v1/factors/import | research:read, research:write |
| list_strategies | core | GET /api/v1/strategies | research:read |
| get_strategy | core | GET /api/v1/strategies/{key} | research:read |
| create_strategy | core | POST /api/v1/strategies | research:read, research:write |
| update_strategy | core | PUT /api/v1/strategies/{key} | research:read, research:write |
| delete_strategy | cleanup | DELETE /api/v1/strategies/{key} | research:read, research:write |
| export_strategies | files | POST /api/v1/strategies/export | research:read |
| import_strategies | files | POST /api/v1/strategies/import | research:read, research:write |
| list_stock_pools | core | GET /api/v1/stock-pools | research:read |
| get_stock_pool | core | GET /api/v1/stock-pools/{key} | research:read |
| create_stock_pool | core | POST /api/v1/stock-pools | research:read, research:write |
| update_stock_pool | core | PATCH /api/v1/stock-pools/{key} | research:read, research:write |
| delete_stock_pool | cleanup | DELETE /api/v1/stock-pools/{key} | research:read, research:write |
| export_stock_pools | files | POST /api/v1/stock-pools/export | research:read |
| import_stock_pools | files | POST /api/v1/stock-pools/import | research:read, research:write |
| list_signal_sessions | signals | GET /api/v1/signal-sessions | research:read |
| get_signal_session | signals | GET /api/v1/signal-sessions/{key} | research:read |
| create_signal_session | signals | POST /api/v1/signal-sessions | research:read, signals:write |
| delete_signal_session | cleanup | DELETE /api/v1/signal-sessions/{key} | research:read, signals:write |
| create_factor_category | core | POST /api/v1/factors/categories | research:read, research:write |
| rename_factor_category | core | PATCH /api/v1/factors/categories/{name} | research:read, research:write |
| update_factor_category_members | core | POST /api/v1/factors/categories/members | research:read, research:write |
| delete_factor_category | cleanup | DELETE /api/v1/factors/categories/{name} | research:read, research:write |
| delete_job | cleanup | DELETE /api/v1/jobs/{job_id} | research:read, research:write |
| delete_run | cleanup | DELETE /api/v1/runs/{run_id} | research:read, research:write |
| delete_upload | cleanup | DELETE /api/v1/uploads/{key} | research:read, research:write |
| list_ocr_providers | files | GET /api/v1/report-factors/ocr-providers | research:read |
| commit_report_factors | files | POST /api/v1/report-factors/commit | research:read, research:write |
| get_signal_history | signals | GET /api/v1/signal-sessions/{key}/history | research:read |
| get_signal_cashflows | signals | GET /api/v1/signal-sessions/{key}/cashflows | research:read |
| adjust_simulation_cash | signals | POST /api/v1/signal-sessions/{key}/cash | research:read, signals:write |
| list_schedules | schedules | GET /api/v1/schedules | research:read |
| create_schedule | schedules | POST /api/v1/schedules | research:read, schedules:write, jobs:submit |
| update_schedule | schedules | PUT /api/v1/schedules/{key} | research:read, schedules:write, jobs:submit |
| delete_schedule | cleanup | DELETE /api/v1/schedules/{key} | research:read, schedules:write |
| run_schedule | schedules | POST /api/v1/schedules/{key}/run | research:read, schedules:write, jobs:submit |
| get_schedule_runtime | schedules | GET /api/v1/schedules/runtime/status | research:read |
| start_mining | core | POST /api/v1/jobs | research:read, jobs:submit, research:write |
| start_aff_mining | core | POST /api/v1/jobs | research:read, jobs:submit |
| start_gp_mining | core | POST /api/v1/jobs | research:read, jobs:submit |
| start_rl_mining | core | POST /api/v1/jobs | research:read, jobs:submit |
| submit_factor_backtest | core | POST /api/v1/jobs | research:read, jobs:submit |
| submit_strategy_backtest | core | POST /api/v1/jobs | research:read, jobs:submit, research:write |
| extract_report_factors | files | POST /api/v1/jobs | research:read, jobs:submit |
| preview_daily_signals | signals | POST /api/v1/jobs | research:read, jobs:submit |
| advance_daily_signals | signals | POST /api/v1/jobs | research:read, jobs:submit, signals:write |
| download_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| update_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| prepare_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| convert_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| apply_data_adjustment | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| refresh_symbol_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| trim_symbol_data | cleanup | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| adjust_symbol_data | data | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| delete_symbol_data | cleanup | POST /api/v1/jobs | research:read, jobs:submit, data:write |
| get_schedule | schedules | GET /api/v1/schedules/{key} | research:read |
| pause_schedule | schedules | PUT /api/v1/schedules/{key} | research:read, schedules:write, jobs:submit |
| resume_schedule | schedules | PUT /api/v1/schedules/{key} | research:read, schedules:write, jobs:submit |
| read_artifact_json | core | GET /api/v1/artifacts/{artifact_id}/content | research:read |
