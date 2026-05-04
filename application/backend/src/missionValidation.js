import yaml from "js-yaml";

const coordinateValid = (value) =>
  Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));

const coordinateListValid = (value) => Array.isArray(value) && value.length > 0 && value.every(coordinateValid);

export function validateMissionFilename(filename) {
  const value = String(filename || "").trim();
  if (!/^[a-zA-Z0-9._-]+\.ya?ml$/.test(value)) {
    return { ok: false, message: "Filename must end with .yaml or .yml." };
  }
  return { ok: true, filename: value };
}

export function validateMissionYaml(yamlText) {
  let parsed;
  try {
    parsed = yaml.load(yamlText);
  } catch (error) {
    return { ok: false, message: `Invalid YAML syntax: ${error.message}` };
  }

  const environment = parsed?.environment;
  const mission = parsed?.mission;
  const valid =
    environment &&
    coordinateListValid(environment.Geofence?.points) &&
    coordinateListValid(environment.waypoints?.points) &&
    coordinateValid(environment.red_target) &&
    coordinateValid(environment.x_target) &&
    coordinateValid(environment.number_target) &&
    Array.isArray(mission?.steps) &&
    mission.steps.length > 0;

  if (!valid) {
    return {
      ok: false,
      message:
        "YAML must include environment.{Geofence.points, waypoints.points, red_target, x_target, number_target} with [lat,long,alt_m] coordinates and mission.steps.",
    };
  }

  return { ok: true, parsed };
}
