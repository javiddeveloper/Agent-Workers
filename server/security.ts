// Request checks for the local console. Binding to 127.0.0.1 is not enough: with DNS rebinding a
// web page on another domain can reach this port, so every request must name this server as its Host.
import type express from 'express';

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return !!host && allowedHosts(port).includes(host.toLowerCase());
}

/** Rejects requests whose Host header is not this server (blocks DNS rebinding). */
export function hostGuard(port: number): express.RequestHandler {
  return (req, res, next) => {
    if (!isAllowedHost(req.headers.host, port)) return res.status(403).send('Forbidden host');
    next();
  };
}
