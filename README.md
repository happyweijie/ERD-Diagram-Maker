# ERD Diagram Drawer

A lightweight browser-based ERD editor for Chen-style entity-relationship diagrams. It uses SVG for crisp shapes and local browser storage for persistence.

## Run

```powershell
node server.js
```

Then open:

```text
http://localhost:4173
```

## Use

- Pick a tool from the left toolbar, then click the canvas to create items.
- Use **Connector** to click one item, then another item, creating entity-relationship or attribute connectors.
- Select an item to edit its name, weak/entity status, attribute type, relationship cardinality, participation, role name, and notes.
- Drag nodes to move them. Use the blue handle to resize selected nodes.
- Hold `Ctrl` and scroll to zoom. Drag blank canvas space to pan.
- Use `Delete`, `Ctrl+Z`, and `Ctrl+Y` for delete, undo, and redo.
- Toggle grid and snap from the toolbar.
- Use **PNG** to export a high-resolution image of the whole diagram.
- Use **Clear** to reset the canvas after confirmation.

## Persistence

The app auto-saves every meaningful change to `localStorage` using a versioned project JSON schema:

```json
{
  "metadata": {
    "title": "Untitled ERD",
    "description": "",
    "createdAt": "...",
    "updatedAt": "...",
    "version": 1
  },
  "viewport": { "zoom": 1, "pan": { "x": 160, "y": 90 } },
  "settings": { "grid": true, "snap": true, "theme": "light" },
  "nodes": [],
  "edges": []
}
```

Reloading the page restores the last diagram in the same browser.
