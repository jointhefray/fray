declare module 'cloudflare:sockets' {
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<unknown>;
    closed: Promise<void>;
    close(): Promise<void>;
  }

  export function connect(
    address: { hostname: string; port: number },
    options: { secureTransport: 'on' },
  ): Socket;
}
