//! System statistics endpoint.
//!
//! `GET /api/system/stats` -> `{ hostname, uptime_secs, cpu_usage,
//! mem_total, mem_used, load_avg }`.
//!
//! The blocking sysinfo sampling stays in the handler (IO at the edge);
//! [`shape_stats`] is the pure transformation from a sampled [`System`]
//! into the serializable [`SystemStats`] view.

use axum::Json;
use serde::Serialize;
use sysinfo::System;

#[derive(Debug, Serialize)]
pub struct LoadAvg {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

#[derive(Debug, Serialize)]
pub struct SystemStats {
    pub hostname: String,
    pub uptime_secs: u64,
    pub cpu_usage: f32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub load_avg: LoadAvg,
}

/// Pure: shape a sampled [`System`] into the API view model.
pub fn shape_stats(sys: &System) -> SystemStats {
    let load = System::load_average();
    SystemStats {
        hostname: System::host_name().unwrap_or_else(|| "unknown".to_string()),
        uptime_secs: System::uptime(),
        cpu_usage: sys.global_cpu_usage(),
        mem_total: sys.total_memory(),
        mem_used: sys.used_memory(),
        load_avg: LoadAvg {
            one: load.one,
            five: load.five,
            fifteen: load.fifteen,
        },
    }
}

/// GET /api/system/stats
///
/// CPU usage needs two samples to be meaningful, so the blocking task
/// refreshes, waits briefly, then refreshes again.
pub async fn stats_handler() -> Json<SystemStats> {
    let stats = tokio::task::spawn_blocking(|| {
        let mut sys = System::new_all();
        sys.refresh_all();
        std::thread::sleep(std::time::Duration::from_millis(300));
        sys.refresh_all();
        shape_stats(&sys)
    })
    .await
    .unwrap_or_else(|_| SystemStats {
        hostname: "unknown".to_string(),
        uptime_secs: 0,
        cpu_usage: 0.0,
        mem_total: 0,
        mem_used: 0,
        load_avg: LoadAvg {
            one: 0.0,
            five: 0.0,
            fifteen: 0.0,
        },
    });
    Json(stats)
}
