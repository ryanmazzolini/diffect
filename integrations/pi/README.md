# Diffect ⇄ Pi

Diffect Reviews live in the clean, repository-owned store under
`$XDG_CONFIG_HOME/diffect/` (default `~/.config/diffect/`). Review IDs are opaque
and remain stable across daemon restarts.

Install this local Pi package and reload Pi. The extension registers:

```text
diffect_open
diffect_list_feedback
diffect_pr
```

`diffect_open` resolves the current Git checkout, starts or reuses the Review
daemon at `http://127.0.0.1:7421`, registers the workspace, and returns its
Current changes URL. Pass `open: true` to open the URL.

After the first inline comment creates a Review, copy its `rvw_…` ID or canonical
link and read it exactly:

```json
{ "reviewId": "rvw_0123456789abcdef0123456789abcdef" }
```

Exact reads call:

```sh
diffect review show <review-id> --json
```

They do not reconstruct Git scopes, start a daemon, scan old thread files, or
return unrelated feedback. Clean Pi reply, resolve, proactive-comment, and watch
operations will be added on the Review mutation service in later changes.

`diffect_pr` remains available for the independent local PR Draft packet. Put
`diffect` and `diffectd` on `PATH`, or build the checkout containing this
extension before use.
