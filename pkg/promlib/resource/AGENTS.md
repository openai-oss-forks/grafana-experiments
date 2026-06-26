# Prometheus resource compression

The Prometheus resource path is a transforming proxy, not a byte-for-byte HTTP
proxy. It inspects ordinary Prometheus JSON responses and may transform them
into Grafana multi-batch or compact frames.

Keep compression negotiation separate for the two HTTP hops:

- Browser Accept-Encoding applies only to browser -> Grafana. Strip it
  before Grafana calls OQP.
- For ordinary, non-multi-batch resource requests, do not replace the stripped
  header. Go's HTTP transport should add Accept-Encoding: gzip when
  appropriate and transparently decompress the upstream response before
  Grafana parses it.
- Do not override upstream negotiation for multi-batch requests in Grafana.
  The component that emits an MBRH / MBBF response (for example Trickster or
  OQP) must leave the whole HTTP body uncompressed; payload-level compression
  belongs to the multi-batch protocol itself.

Content-Encoding must always describe the bytes on that HTTP hop. When Grafana
turns an upstream JSON response into multi-batch frames, it removes the
upstream Content-Encoding because the new response body is identity-encoded.
The same rule applies on the Grafana -> browser hop: a multi-batch sender must
not apply whole-response compression, while any separately negotiated ordinary
response compression must set its own accurate Content-Encoding.

Do not forward the browser's compression preference through
pkg/promlib/client.QueryResource. Leaving Accept-Encoding unset on the new
Grafana -> OQP request lets Go own that hop's negotiation and decoding.
