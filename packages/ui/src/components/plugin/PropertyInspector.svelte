<script lang="ts">
  /**
   * Hosts an Elgato-compatible Property Inspector HTML page in an iframe.
   * The PI connects to the WebSocket server to communicate with its plugin.
   */

  let { piUrl, wsPort, pluginUuid, actionInfo }: {
    piUrl: string;
    wsPort: number;
    pluginUuid: string;
    actionInfo: string;
  } = $props();

  // Build the PI URL with connection params as query string
  let fullUrl = $derived(() => {
    const params = new URLSearchParams({
      port: String(wsPort),
      uuid: pluginUuid,
      event: "registerPropertyInspector",
      info: JSON.stringify({
        application: { language: "en", platform: "linux", version: "0.1.0" },
        plugin: { uuid: pluginUuid, version: "1.0.0" },
        devices: [],
        devicePixelRatio: 1,
      }),
      actionInfo: actionInfo,
    });
    return `${piUrl}?${params.toString()}`;
  });
</script>

<div class="pi-container">
  <iframe
    class="pi-frame"
    src={fullUrl()}
    title="Property Inspector"
    sandbox="allow-scripts allow-same-origin allow-forms"
  ></iframe>
</div>

<style>
  .pi-container {
    width: 100%;
    height: 100%;
    min-height: 300px;
  }

  .pi-frame {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: var(--radius-sm);
    background: white;
  }
</style>
