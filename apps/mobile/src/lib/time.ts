const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

export const relativeTime = (isoDate: string): string => {
  const deltaMs = new Date(isoDate).getTime() - Date.now();
  const absolute = Math.abs(deltaMs);

  if (absolute < hour) {
    return formatRelativeUnit(Math.round(deltaMs / minute), "minute");
  }

  if (absolute < day) {
    return formatRelativeUnit(Math.round(deltaMs / hour), "hour");
  }

  return formatRelativeUnit(Math.round(deltaMs / day), "day");
};

export const compactTime = (isoDate: string): string => {
  const date = new Date(isoDate);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");

  return `${hours}:${minutes}`;
};

const formatRelativeUnit = (value: number, unit: "minute" | "hour" | "day"): string => {
  if (value === 0) {
    return "now";
  }

  const absolute = Math.abs(value);
  const label = absolute === 1 ? unit : `${unit}s`;

  return value > 0 ? `in ${absolute} ${label}` : `${absolute} ${label} ago`;
};
