import { config } from "dotenv";

import { parsePossibleBoolean } from "./utils";

config();

const VERBOSE = parsePossibleBoolean(process.env.VERBOSE) ?? true;

export const log = (...args: any[]): void => {
    if (VERBOSE) {
        console.log(...args);
    }
};
