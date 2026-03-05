export interface OrkisAPI {
  ping: () => void
}

declare global {
  interface Window {
    api: OrkisAPI
  }
}
