# Wireless CNC Architecture — Design Notes

## Overview

This document captures the brainstorming and design decisions around a wireless
interface for LinuxCNC axis nodes, replacing physical fieldbus connections
(EtherCAT, step/dir cables, etc.) with an open, royalty-free OTA protocol.

---

## Goals

- Connect axis nodes and motion actuators to a LinuxCNC master **without physical
  wiring** between controller and actuators
- Each node is **self-contained**: owns its own encoder, step generation, and
  local fault handling
- **No proprietary protocols**: avoid vendor lock-in, licensing fees, and legal
  constraints
- Architecture must be **compositional**: adding a new node should require no
  changes to the master beyond HAL configuration
- Distance between nodes and master should be **largely irrelevant** (within
  reason for the chosen RF technology)

---

## Protocol Selection

### Rejected Options

| Protocol | Reason for rejection |
|---|---|
| Zigbee | Too slow — 250 Kbps MAC throughput, non-deterministic latency |
| EtherCAT Wireless | ETG membership and conformance licensing fees |
| Private 5G / URLLC | 3GPP patent pools, SEP licensing, infrastructure cost |
| WirelessHART | FieldComm Group membership fees |
| Proprietary FHSS | Mixed/closed licensing |

### Selected Primary Protocol: **IEEE 802.15.4z UWB (DW3000)**

- Fully open IEEE standard, no licensing fees
- Hardware: **Qorvo DW3000** — open datasheet, Apache 2.0 SDK on GitHub
- Sub-nanosecond hardware timestamping baked into the MAC
- TDMA scheduling gives deterministic channel access
- Linux kernel has `ieee802154` subsystem with active upstream development
- Sufficient bandwidth for the node contract at 1 kHz servo thread rate

### Secondary / Auxiliary Protocol: **OpenWSN / 6TiSCH (IEEE 802.15.4e)**

For slow auxiliary nodes (tool changers, coolant valves, conveyors) where
determinism requirements are relaxed and mesh or longer range is needed.

| Property | UWB (DW3000) | OpenWSN/TSCH |
|---|---|---|
| Min cycle time | ~150 µs/node | ~2–4 ms/slot |
| Timing jitter | ~1–10 ns | ~1–10 µs |
| Range (free space) | 10–30m @ 6.8 Mbps | 100m+ |
| Multi-hop mesh | ❌ Star only | ✅ Native |
| Best use | Fast axes (X/Y/Z/A) | Slow auxiliaries |

---

## UWB Physical Layer Parameters

| Parameter | Value |
|---|---|
| Chip | Qorvo DW3000 |
| Max payload | 1023 bytes (extended) / 127 bytes (standard) |
| Node contract frame size | ~22 bytes (fits either mode trivially) |
| Data rate (primary) | 6.8 Mbps |
| Data rate (extended range) | 850 Kbps |
| TX power limit | −41.3 dBm/MHz (FCC/ETSI regulated — fixed) |
| Free-space range @ 6.8 Mbps | 10–30m |
| Free-space range @ 850 Kbps | 30–60m |

---

## Node Contract (Protocol)

Minimal packet definition. Every node, regardless of axis type, speaks this
interface.

### Master → Node (command, 1 kHz)

| Field | Type | Size |
|---|---|---|
| `enable` | bool | 1 bit |
| `target_position` | int32 (encoder counts) | 4 bytes |
| `target_velocity` | int32 (counts/sec) | 4 bytes |
| `timestamp` | uint64 (nanoseconds, shared clock) | 8 bytes |
| `sequence` | uint16 | 2 bytes |
| **Total** | | **~19 bytes** |

### Node → Master (state, 1 kHz)

| Field | Type | Size |
|---|---|---|
| `uid` | uint16 | 2 bytes |
| `position` | int32 (encoder counts) | 4 bytes |
| `velocity` | int32 (counts/sec) | 4 bytes |
| `status` | uint16 (fault, homed, enabled, …) | 2 bytes |
| `timestamp` | uint64 | 8 bytes |
| `sequence` | uint16 | 2 bytes |
| **Total** | | **~22 bytes** |

Future extensions (temperature, load, etc.) can be appended without breaking
the base contract.

---

## TDMA Slot Budget

At 6.8 Mbps, a 22-byte frame takes ~200 µs including turnaround time.
Round-trip per node slot: **~150 µs**.

With a 1 ms servo thread:

$$N_{max} = \frac{1000\,\mu s}{150\,\mu s} \approx 6 \text{ nodes @ 1 kHz}$$

| Servo Rate | Max Nodes (cmd only) | Max Nodes (cmd + ranging) |
|---|---|---|
| 1 kHz | ~6 | ~3 |
| 500 Hz | ~12 | ~6 |
| 250 Hz | ~24 | ~12 |

> **Note:** Most CNC machines have 3–6 axes, so 1 kHz with command-only is
> entirely feasible. UWB ranging (for homing/safety) should be scheduled at a
> lower rate (e.g., 10 Hz) interleaved between command cycles.

---

## Servo Thread & Step Generation

### The Key Architectural Decision

The master (LinuxCNC) does **not** send step pulses OTA. Step pulse generation
(20–40 kHz) stays on the node. The master sends **position/velocity targets**
at 1 kHz (servo thread rate), and the node interpolates locally.

This is equivalent to **Cyclic Synchronous Position (CSP) mode** in EtherCAT
servo drive terminology.

```
LinuxCNC servo-thread (1 kHz)
    → position/velocity target
        → UWB OTA
            → Node receives target
                → Local interpolator (runs at 20–40 kHz from hardware timer)
                    → STEP/DIR pins to driver IC
```

### LinuxCNC Thread Reference

| Thread | Default Period | Purpose |
|---|---|---|
| `servo-thread` | 1 ms (1 kHz) | PID, trajectory planning, HAL updates |
| `base-thread` | 25–50 µs | Software step gen (not used in this architecture) |

The `base-thread` is irrelevant here — hardware step generation on the node
replaces it entirely.

> The actual achievable servo thread period depends on the host PC's measured
> latency (`latency-histogram`). On a well-tuned `PREEMPT_RT` system, 500 µs
> or better is achievable.

---

## Node Internal Architecture

```
┌─────────────────────────────────────────┐
│  Node MCU                               │
│                                         │
│  UWB RX → parse command     (1 kHz)     │
│         ↓                               │
│  Local interpolator      (20–40 kHz)    │
│         ↓                               │
│  Hardware timer → STEP/DIR pins         │
│                                         │
│  Encoder counter → position feedback    │
│         ↓                               │
│  UWB TX → state report      (1 kHz)     │
└─────────────────────────────────────────┘
```

### Candidate MCUs

| MCU | Strengths |
|---|---|
| STM32F4 / F7 | Hardware timers, DMA encoder counting, mature ecosystem |
| RP2040 | Dual-core, PIO for step gen, low cost |
| ESP32-S3 | Wi-Fi fallback option, widely available |

---

## Fault & Loss Handling (Node Side)

| Consecutive missed packets | Node action |
|---|---|
| 1–2 | Continue on last velocity vector |
| 3–5 | Decelerate to zero under local control |
| 6+ | Fault state, disable drive output |

Thresholds are tunable per node type and application.

---

## Range Extension Options

TX power is regulated and fixed. Range can be extended by:

| Method | Range Est. | Complexity | Latency Impact |
|---|---|---|---|
| Drop to 850 Kbps | ~30–60m radius | None | Minimal (+50 µs/frame) |
| + Directional antennas (6–9 dBi) | ~50m radius | Low | None |
| + Relay node | ~60m radius | Low | +150 µs |
| Dual host-side anchors | ~30m per anchor | Medium | None |
| Sub-GHz channel (499.2 MHz) | ~80m+ | Medium | None |

**Recommended for large installations:** 850 Kbps + directional antennas +
dual host anchors. Covers ~50–60m radius with no relay latency.

---

## Future Architecture: Pre-Distributed Trajectory

For very large installations (>60m, factory floor) or ultra-low-bandwidth
scenarios, an alternative **store-and-execute** model is viable:

- Master distributes the full job trajectory to each node at job start (burst)
- During execution, master sends only **sync ticks** — minimal OTA bandwidth
- Nodes execute pre-loaded trajectory autonomously, synchronized to shared clock
- Master monitors telemetry only

| Property | CSP (current) | Pre-distributed |
|---|---|---|
| OTA bandwidth | ~1 kHz continuous | Burst at start + sync ticks |
| Flexibility | Full (pause, override, feedrate) | Low (pre-baked path) |
| Range | 10–30m (extendable) | Essentially unlimited |
| Node complexity | Low | High (path execution engine) |
| Fault recovery | Master intervenes | Node must self-manage |

The node contract requires only a new `load_trajectory` command type — the base
contract is otherwise unchanged. **Not needed for current scope.**

---

## HAL Integration (LinuxCNC Host Side)

A new HAL component (`hal_wireless` or similar) abstracts all nodes:

- Modelled after `hal_ethercat` / `hostmot2` — same pin abstraction pattern
- Each node appears as a set of HAL pins (position-cmd, position-fb, enable,
  fault, etc.)
- The component owns the UWB host-side transceiver (SPI/USB) and TDMA scheduler
- Master has no knowledge of the wireless transport — it just reads/writes HAL pins

---

## Current Design Summary

| Decision | Choice |
|---|---|
| Primary wireless protocol | IEEE 802.15.4z UWB (DW3000) |
| Topology | Star — single host anchor |
| Data rate | 6.8 Mbps (850 Kbps if range needed) |
| Servo mode | CSP — position/velocity targets at 1 kHz |
| Step generation | On-node hardware timer (20–40 kHz) |
| Sync mechanism | UWB hardware timestamps (shared distributed clock) |
| Auxiliary nodes | OpenWSN/TSCH for slow, long-range peripherals |
| Proprietary dependencies | None |
