type AsyncReadableStream<T> = ReadableStream<T> & AsyncIterable<T>;

/**
 * Older WKWebView builds expose ReadableStream without Symbol.asyncIterator.
 * PDF.js consumes its text stream with `for await`, so install the small part
 * of the Streams API that WebKit is missing before a PDF is opened.
 */
export function installWebKitStreamCompatibility() {
  if (typeof ReadableStream === "undefined" || Symbol.asyncIterator in ReadableStream.prototype) {
    return;
  }

  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* <T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function hasAsyncReadableStream<T>(stream: ReadableStream<T>): stream is AsyncReadableStream<T> {
  return Symbol.asyncIterator in stream;
}
