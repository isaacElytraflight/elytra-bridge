# Drone 2026 buttons

Buttons are declared in `project.yaml` and map to scripts in this compartment.

The `scripts` directory is the single runtime source for custom button scripts. Elytra Bridge points sim and physical targets at these paths:

- Takeoff: `start_drone.sh [mission_yaml]`
- Passive Record: `start_recording.sh`
- End Mission: sends Ctrl+C to tmux; in simulation the UI also exposes Reset Simulation for the upstream SITL reset workflow.