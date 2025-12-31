figma.showUI(__html__, { width: 400, height: 500 });

type UploaderImage = {
  name: string;
  data: Uint8Array;
};

const ROOM_KEYWORDS = [
  'Owners_Bath',
  'Owners_WIC',
  'Owners',
  'Kitchen',
  'Kitchenette',
  'Dining',
  'Great',
  'Living',
  'Family',
  'Bed2',
  'Bed3',
  'Bed4',
  'Bed5',
  'Bedroom',
  'Bath2',
  'Bath3',
  'Bath4',
  'Bath',
  'Powder',
  'Laundry',
  'Garage',
  'Entry',
  'Foyer',
  'Office',
  'Study',
  'WIC',
  'Suite',
  'Den',
  'Loft',
  'Bonus',
  'Media',
  'Game',
  'Gym',
  'Flex',
  'CoveredPatio',
  'Deck',
  'Patio',
  'Nook',
] as const;

type RoomKeyword = (typeof ROOM_KEYWORDS)[number];

interface RoomKeywordInfo {
  raw: RoomKeyword;
  norm: string;
}

// ---------- Normalization / parsing utilities ----------

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stripExtension(name: string): string {
  return name.replace(/\.[^/.]+$/, '');
}

const ROOM_KEYWORD_INFO: RoomKeywordInfo[] = ROOM_KEYWORDS
  .map((raw) => ({ raw, norm: normalizeToken(raw) }))
  .sort((a, b) => b.norm.length - a.norm.length);

/**
 * Filename -> target layer name
 *
 * Examples:
 *  "…Kitchen_3of4…"                        -> "Kitchen_3"
 *  "…Game_1of2…"                           -> "Game_1"
 *  "…Bath3_F2"                             -> "Bath3_1"
 *  "…CoveredPatio_1of2…"                   -> "CoveredPatio_1"
 *  "…Patio_1of2…"                          -> "Patio_1"
 */
function parseFilenameToTargetLayer(name: string): string | null {
  const base = stripExtension(name);
  const normalized = normalizeToken(base);

  let matchedKeyword: RoomKeywordInfo | null = null;
  
  // Try to find the best match - prioritize longer/more specific matches
  // and ensure we match the keyword boundaries properly
  for (const info of ROOM_KEYWORD_INFO) {
    // Check if the normalized filename contains this keyword
    // Use word boundary matching to avoid "kitchen" matching "kitchenette"
    const pattern = new RegExp(`(^|_)${info.norm}($|_)`, 'i');
    if (pattern.test(normalized)) {
      matchedKeyword = info;
      break;
    }
  }
  
  if (!matchedKeyword) return null;

  let index: string | null = null;

  // Find the position of the matched keyword in the normalized string
  const keywordPattern = new RegExp(`(^|_)${matchedKeyword.norm}($|_)`, 'i');
  const keywordMatch = normalized.match(keywordPattern);

  if (keywordMatch) {
    const keywordEndIndex = (keywordMatch.index || 0) + keywordMatch[0].length;
    const afterKeyword = normalized.substring(keywordEndIndex);

    // pattern: 3of4 / 1of2 etc (after the keyword)
    const ofMatch = afterKeyword.match(/^_?(\d+)(?=_?of\d+)/);
    if (ofMatch) index = ofMatch[1];

    // pattern: _3_, _3 at end, or just 3 (after the keyword)
    if (!index) {
      const underscoreMatch = afterKeyword.match(/^_?(\d+)(?:_|$)/);
      if (underscoreMatch) index = underscoreMatch[1];
    }
  }

  // default to 1 if no explicit index
  if (!index) index = '1';

  return `${matchedKeyword.raw}_${index}`;
}

function hasFills(node: SceneNode): node is SceneNode & GeometryMixin {
  return 'fills' in node;
}

function namesMatch(a: string, b: string): boolean {
  return normalizeToken(a) === normalizeToken(b);
}

function findLayerByName(
  container: SceneNode & ChildrenMixin,
  targetName: string
): SceneNode | null {
  const targetNorm = normalizeToken(targetName);

  return container.findOne((node) => {
    if (!hasFills(node)) return false;
    const nodeNorm = normalizeToken(node.name);
    return nodeNorm === targetNorm;
  }) as SceneNode | null;
}

function getSelectedContainer():
  | { container: SceneNode & ChildrenMixin }
  | { error: string } {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return {
      error:
        'No frame selected. Please select a single frame (or group/component) containing your room layout and try again.',
    };
  }

  if (selection.length > 1) {
    return {
      error:
        'Multiple nodes selected. Please select a single frame (or group/component) containing your room layout and try again.',
    };
  }

  const node = selection[0];

  if ('children' in node) {
    return { container: node as SceneNode & ChildrenMixin };
  }

  return {
    error:
      'Selected node cannot contain layers. Please select a frame, group, component, or instance that contains the image layers.',
  };
}

// ---------- Auto-seed / "Reset Layers" helpers ----------

function isImageLayer(node: SceneNode): node is SceneNode & GeometryMixin {
  if (!hasFills(node)) return false;

  switch (node.type) {
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'POLYGON':
    case 'STAR':
    case 'VECTOR':
    case 'BOOLEAN_OPERATION':
    case 'LINE':
      return true;
    default:
      return false;
  }
}

/**
 * Owners Suite block detection
 */
function isOwnersSuiteTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.includes('owner') && lower.includes('suite');
}

/**
 * Room title text -> canonical token used in layer names.
 */
function deriveRoomTokenFromText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const firstLine = trimmed.split('\n')[0].trim();

  // Bedroom N -> BedN
  const bedMatch = firstLine.match(/bed(room)?\s*(\d+)/i);
  if (bedMatch) {
    return `Bed${bedMatch[2]}`;
  }

  // Bath N -> BathN
  const bathMatch = firstLine.match(/bath(room)?\s*(\d+)/i);
  if (bathMatch) {
    return `Bath${bathMatch[2]}`;
  }

  // Game / Game Room
  if (/game/i.test(firstLine)) {
    return 'Game';
  }

  const normalized = normalizeToken(firstLine);

  for (const info of ROOM_KEYWORD_INFO) {
    // Use word boundary matching to avoid "kitchen" matching "kitchenette"
    const pattern = new RegExp(`(^|_)${info.norm}($|_)`, 'i');
    if (pattern.test(normalized)) {
      return info.raw;
    }
  }

  const fallback = firstLine.replace(/[^a-zA-Z0-9]+/g, '');
  if (!fallback) return null;
  return fallback;
}

interface AutoSeedResult {
  renamedLayers: number;
  processedBlocks: number;
  issues: string[];
}

/**
 * For each "room block" (top-level child with children):
 *  - Owners Suite:
 *      Owners_1, Owners_2, Owners_Bath_1, Owners_Bath_2, Owners_WIC
 *  - Default:
 *      <Token>_1, <Token>_2, ...
 */
function autoSeedRoomNames(
  container: SceneNode & ChildrenMixin
): AutoSeedResult {
  let renamedLayers = 0;
  let processedBlocks = 0;
  const issues: string[] = [];

  const blocks = container.children.filter(
    (node) => 'children' in node
  ) as (SceneNode & ChildrenMixin)[];

  if (blocks.length === 0) {
    issues.push(
      'No room blocks found. Expected child groups/frames under the selected node.'
    );
    return { renamedLayers, processedBlocks, issues };
  }

  for (const block of blocks) {
    const titleNode = block.findOne(
      (node) => node.type === 'TEXT'
    ) as TextNode | null;

    if (!titleNode) {
      issues.push(`Block "${block.name}": no text node found for room title.`);
      continue;
    }

    const title = titleNode.characters.trim();
    if (!title) {
      issues.push(`Block "${block.name}": title text is empty.`);
      continue;
    }

    const imageNodes = block.findAll((node) => isImageLayer(node)) as (
      SceneNode & GeometryMixin
    )[];

    if (imageNodes.length === 0) {
      issues.push(`Block "${block.name}": no image layers found to rename.`);
      continue;
    }

    // Sort by visual position: top-to-bottom, then left-to-right
    imageNodes.sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });

    // Special-case: Owners Suite block
    if (isOwnersSuiteTitle(title)) {
      const pattern = [
        'Owners_1',
        'Owners_2',
        'Owners_Bath_1',
        'Owners_Bath_2',
        'Owners_WIC_1',
      ];

      for (let i = 0; i < imageNodes.length; i++) {
        const img = imageNodes[i];
        if (i < pattern.length) {
          img.name = pattern[i];
        } else {
          img.name = `Owners_${i + 1}`;
        }

        // Replace with blue-ish placeholder fill
        img.fills = [
          {
            type: 'SOLID',
            color: { r: 0.53, g: 0.73, b: 0.93 }, // Light blue color
          },
        ];

        renamedLayers += 1;
      }

      processedBlocks += 1;
      continue;
    }

    // Default behavior for all other blocks
    const token = deriveRoomTokenFromText(title);
    if (!token) {
      issues.push(
        `Block "${block.name}": could not derive room token from "${title}".`
      );
      continue;
    }

    let index = 1;
    for (const img of imageNodes) {
      img.name = `${token}_${index}`;

      // Replace with blue-ish placeholder fill
      img.fills = [
        {
          type: 'SOLID',
          color: { r: 0.53, g: 0.73, b: 0.93 }, // Light blue color
        },
      ];

      index += 1;
      renamedLayers += 1;
    }

    processedBlocks += 1;
  }

  return { renamedLayers, processedBlocks, issues };
}

// ---------- Main UI message handler ----------

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'upload-images') {
    const images: UploaderImage[] = msg.images || [];
    const totalImages = images.length;

    let updatedCount = 0;
    const notFoundLayers: string[] = [];

    if (totalImages === 0) {
      figma.ui.postMessage({
        type: 'upload-complete',
        updatedCount,
        totalImages,
        notFoundLayers: ['No images received from the UI.'],
      });
      return;
    }

    const selected = getSelectedContainer();

    if ('error' in selected) {
      notFoundLayers.push(selected.error);
      figma.ui.postMessage({
        type: 'upload-complete',
        updatedCount,
        totalImages,
        notFoundLayers,
      });
      return;
    }

    const { container } = selected;

    for (const imageData of images) {
      const { name, data } = imageData;

      const targetLayerName = parseFilenameToTargetLayer(name);
      if (!targetLayerName) {
        notFoundLayers.push(
          `${name} → No room keyword found (expected something like Kitchen, Owners, Bed2, Bath3, Game, CoveredPatio, Patio, etc.).`
        );
        continue;
      }

      const matchingNode = findLayerByName(container, targetLayerName);
      if (!matchingNode) {
        notFoundLayers.push(
          `${name} → Could not find layer "${targetLayerName}" in the selected frame.`
        );
        continue;
      }

      if (!hasFills(matchingNode)) {
        notFoundLayers.push(
          `${name} → Layer "${matchingNode.name}" cannot accept image fills.`
        );
        continue;
      }

      if ('locked' in matchingNode && matchingNode.locked) {
        notFoundLayers.push(
          `${name} → Layer "${matchingNode.name}" is locked in Figma.`
        );
        continue;
      }

      try {
        const imageHash = figma.createImage(data).hash;
        const newFills: Paint[] = [
          {
            type: 'IMAGE',
            imageHash,
            scaleMode: 'FILL',
          },
        ];

        matchingNode.fills = newFills;

        // Rename layer to full filename (no extension)
        const newName = stripExtension(name);
        matchingNode.name = newName;

        // Also rename parent group/frame if it still has the canonical target name
        const parent = matchingNode.parent;
        if (parent && 'name' in parent && namesMatch(parent.name, targetLayerName)) {
          (parent as SceneNode).name = newName;
        }

        updatedCount += 1;
      } catch (err) {
        notFoundLayers.push(
          `${name} → Failed to apply image to "${matchingNode.name}". Error: ${err}`
        );
      }
    }

    figma.ui.postMessage({
      type: 'upload-complete',
      updatedCount,
      totalImages,
      notFoundLayers,
    });

    return;
  }

  if (msg.type === 'auto-seed-room-names') {
    const selected = getSelectedContainer();

    if ('error' in selected) {
      figma.ui.postMessage({
        type: 'auto-seed-complete',
        renamedLayers: 0,
        processedBlocks: 0,
        issues: [selected.error],
      });
      return;
    }

    const { container } = selected;
    const result = autoSeedRoomNames(container);

    figma.ui.postMessage({
      type: 'auto-seed-complete',
      renamedLayers: result.renamedLayers,
      processedBlocks: result.processedBlocks,
      issues: result.issues,
    });

    return;
  }
};