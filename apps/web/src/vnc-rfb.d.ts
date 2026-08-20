declare module "@novnc/novnc" {
  interface RFBCredentials {
    password?: string;
    username?: string;
    target?: string;
  }

  interface RFBDisconnectDetail {
    clean: boolean;
    code: number;
    message: string;
  }

  interface RFBCredentialsRequiredDetail {
    types: string[];
  }

  interface RFBSecurityFailureDetail {
    reason: string;
    status: number | null;
  }

  interface RFBEventMap {
    connect: Event;
    disconnect: CustomEvent<RFBDisconnectDetail>;
    credentialsrequired: CustomEvent<RFBCredentialsRequiredDetail>;
    securityfailure: CustomEvent<RFBSecurityFailureDetail>;
    desktopname: CustomEvent<{ name: string }>;
    clipboard: CustomEvent<{ text: string }>;
  }

  class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: RFBCredentials; wsProtocols?: string[]; shared?: boolean; repeaterID?: string }
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    addEventListener<K extends keyof RFBEventMap>(type: K, listener: (event: RFBEventMap[K]) => void): void;
    removeEventListener<K extends keyof RFBEventMap>(type: K, listener: (event: RFBEventMap[K]) => void): void;
    connect(): void;
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    requestFullscreen(): void;
    focus(): void;
  }

  export default RFB;
}