import { spawn } from "node:child_process";
const SINGLE_QUOTE_ESCAPE = "'\"'\"'";
export function quoteScpPath(value) {
    return `'${value.replace(/'/g, SINGLE_QUOTE_ESCAPE)}'`;
}
export function formatScpSource(remoteHost, remotePath) {
    return `${remoteHost}:${quoteScpPath(remotePath)}`;
}
export async function copyRemoteFileViaScp(params) {
    return await new Promise((resolve, reject) => {
        const child = spawn("/usr/bin/scp", [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            formatScpSource(params.remoteHost, params.remotePath),
            params.localPath,
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`scp failed (${code}): ${stderr.trim()}`));
        });
    });
}
