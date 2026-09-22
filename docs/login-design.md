# Login visual design

Both apps consume the shared login component and artwork in `packages/web-auth`.
The left panel stays light; the right panel owns the indigo-to-cyan CSS gradient.
The illustration is a PNG with real alpha transparency, not a baked-in gradient or blend-mode simulation.
Mobile layouts stack the illustration below the sign-in form.

## Artwork provenance

Asset: `packages/web-auth/public/agent-orchestration-transparent.png`.
Generated using the built-in image-generation tool, then edited with the same tool for transparency.

Generation prompt:

> Use case: stylized-concept. Asset type: original illustration for the right panel of an enterprise AI agent platform login screen, not a whole UI screenshot. Create a refined isometric 3D illustration of an AI agent orchestration workspace: one central luminous glass coordination core connected via clean cyan pathways to four smaller specialist agent stations with abstract code, document, research and approval symbols, and two small human operators supervising. White ceramic and translucent ice-blue glass, cobalt and cyan light, precise architectural composition, sophisticated enterprise editorial illustration rather than cartoon robots. Deep indigo blue background (#202e68) subtly transitioning to blue-teal near bottom. Center the entire floating network with generous clear margins, no cropped objects. Landscape 3:2 composition. No text, no words, no logos, no watermarks, no UI form, no cranes. Convey coordinated agents and human control, not a generic data center.

Final transparency-edit prompt:

> Background-extraction edit. Remove the entire blue gradient backdrop from this illustration and output a PNG with genuine transparent alpha background, including spaces between objects. Preserve the central coordination core, four specialist agent stations, their cyan connections, and two human operators, with their current design and composition. Preserve crisp white and ice-blue glass objects and their fine edges. No opaque ground plane, no background color, no checkerboard drawn in the image, no text, no added objects. The asset will be layered on a CSS blue gradient in an app. Keep all objects fully inside the image with a little transparent padding.

Password help explains administrator-managed resets; it does not imply a self-service recovery service. No persistent-session checkbox or organization-code field is included because those features are not supported by the existing authentication flow.
