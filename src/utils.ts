export const parsePossibleBoolean = (value?: string): boolean | undefined => {
    if (value === undefined) return undefined;

    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "true" || normalizedValue === "1") return true;
    if (normalizedValue === "false" || normalizedValue === "0") return false;

    return undefined;
};
