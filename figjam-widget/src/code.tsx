/// <reference types="@figma/widget-typings" />
/// <reference types="@figma/plugin-typings" />

const { widget } = figma;
const { AutoLayout, Text, useSyncedState } = widget;

interface CapturedItem {
  id: string;
  imageUrl: string;
  dataUrl?: string;
  bytes?: Uint8Array | number[];
  sourceUrl: string;
  pageTitle: string;
  domain: string;
  timestamp: number;
  width?: number;
  height?: number;
  altText?: string;
}

function generateRoomCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `DROP-${num}`;
}

function FigDropWidget() {
  const [roomCode, setRoomCode] = useSyncedState<string>('roomCode', () => 'DROP-1000');
  const [pendingCount, setPendingCount] = useSyncedState<number>('pendingCount', 0);

  const openCollector = async () => {
    return new Promise<void>((resolve) => {
      figma.showUI(__html__, {
        width: 320,
        height: 520,
        title: `FigDrop (${roomCode})`
      });

      // Send initial room code to UI modal
      figma.ui.postMessage({
        type: 'INIT_ROOM',
        roomCode: roomCode
      });

      figma.ui.onmessage = async (msg) => {
        if (msg.type === 'CLOSE') {
          resolve();
          figma.closePlugin();
          return;
        }

        if (msg.type === 'SET_ROOM' && msg.roomCode) {
          setRoomCode(msg.roomCode.trim().toUpperCase());
          return;
        }

        if (msg.type === 'UPDATE_COUNT') {
          setPendingCount(msg.count || 0);
          return;
        }

        if (msg.type === 'DROP_ITEMS') {
          const items: CapturedItem[] = msg.items || [];
          const isAutoDrop = Boolean(msg.isAutoDrop);

          if (items.length === 0) {
            if (!isAutoDrop) {
              figma.notify('Queue is empty. Hover web images & click Save to FigJam.', { timeout: 3000 });
            }
            figma.ui.postMessage({ type: 'DROP_COMPLETE' });
            return;
          }

          try {
            const allWidgets = figma.currentPage.findAll((n) => n.type === 'WIDGET');
            const currentWidget = allWidgets.length > 0 ? allWidgets[0] : null;
            const startX = currentWidget ? currentWidget.x + currentWidget.width + 80 : figma.viewport.center.x - 300;

            const numCols = 3;
            const cardWidth = 380;
            const gapX = 32;
            const gapY = 40;
            const totalGridWidth = numCols * cardWidth + (numCols - 1) * gapX;

            // Find existing nodes in the grid area to place new captures cleanly below them
            let startY = currentWidget ? currentWidget.y : figma.viewport.center.y - 200;
            const existingNodesInArea = figma.currentPage.children.filter((node) => {
              if (node.type === 'WIDGET') return false;
              return node.x >= startX - 20 && node.x <= startX + totalGridWidth + 20;
            });

            if (existingNodesInArea.length > 0) {
              const maxBottom = Math.max(...existingNodesInArea.map((n) => n.y + n.height));
              startY = Math.max(startY, maxBottom + 48);
            }

            // Masonry Column Height tracker
            const colHeights = new Array(numCols).fill(0);

            const createdNodes: SceneNode[] = [];

            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              try {
                // Find column with the minimum height
                let targetCol = 0;
                let minH = colHeights[0];
                for (let c = 1; c < numCols; c++) {
                  if (colHeights[c] < minH) {
                    minH = colHeights[c];
                    targetCol = c;
                  }
                }

                const posX = startX + targetCol * (cardWidth + gapX);
                const posY = startY + colHeights[targetCol];

                // Create Image Node directly from raw PNG bytes
                let figmaImg: Image | null = null;
                if (item.bytes) {
                  const uint8 = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
                  if (uint8.length > 0) {
                    figmaImg = figma.createImage(uint8);
                  }
                }

                if (!figmaImg) {
                  console.warn('Could not create image for item:', item.id);
                  continue;
                }

                const imgSize = await figmaImg.getSizeAsync();
                const aspect = imgSize.width > 0 && imgSize.height > 0 ? imgSize.width / imgSize.height : 1.5;
                const cardHeight = Math.min(Math.round(cardWidth / aspect), 560);

                // 1. Image Rectangle with 6px squircle radius and 1px border
                const rect = figma.createRectangle();
                rect.resize(cardWidth, cardHeight);
                rect.cornerRadius = 6;
                rect.fills = [
                  {
                    type: 'IMAGE',
                    scaleMode: 'FILL',
                    imageHash: figmaImg.hash
                  }
                ];
                rect.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
                rect.strokeWeight = 1;
                rect.x = posX;
                rect.y = posY;

                // 2. Source Link Tag
                await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
                const textNode = figma.createText();
                textNode.fontName = { family: 'Inter', style: 'Regular' };
                textNode.characters = `${item.domain} • ${item.pageTitle.substring(0, 32)}`;
                textNode.fontSize = 12;
                textNode.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.45, b: 0.45 } }];
                textNode.hyperlink = { type: 'URL', value: item.sourceUrl };
                textNode.x = posX + 4;
                textNode.y = posY + cardHeight + 8;

                // 3. Group
                const group = figma.group([rect, textNode], figma.currentPage);
                group.name = `${item.domain} — ${item.pageTitle.substring(0, 20)}`;

                createdNodes.push(group);

                // Update column height
                const totalItemHeight = cardHeight + 8 + 18;
                colHeights[targetCol] += totalItemHeight + gapY;
              } catch (err) {
                console.warn('Item drop error:', item.id, err);
              }
            }

            setPendingCount(0);

            if (isAutoDrop) {
              figma.notify(`⚡ Auto-dropped ${createdNodes.length} visual reference${createdNodes.length > 1 ? 's' : ''} to board [${roomCode}]`, {
                timeout: 2500
              });
            } else {
              figma.notify(`Placed ${createdNodes.length} visual reference${createdNodes.length > 1 ? 's' : ''} on canvas`, {
                timeout: 3000
              });
            }

            if (createdNodes.length > 0) {
              figma.currentPage.selection = createdNodes;
              figma.viewport.scrollAndZoomIntoView(createdNodes);
            }

            figma.ui.postMessage({ type: 'DROP_COMPLETE', count: createdNodes.length });
          } catch (err: any) {
            figma.notify(`Sync Error: ${err.message}`, { error: true });
            figma.ui.postMessage({ type: 'DROP_COMPLETE' });
          }
        }
      };
    });
  };

  return (
    <AutoLayout
      direction="vertical"
      padding={18}
      cornerRadius={6}
      fill="#FFFFFF"
      stroke="#E5E5E5"
      strokeWidth={1}
      spacing={12}
      width={290}
    >
      {/* Header with Room Code indicator */}
      <AutoLayout direction="horizontal" width="fill-parent" verticalAlignItems="center" spacing="auto">
        <Text fontSize={14} fontWeight="bold" fill="#1E1E1E">
          FigDrop Collector
        </Text>
        <AutoLayout
          direction="horizontal"
          padding={{ vertical: 2, horizontal: 6 }}
          cornerRadius={4}
          fill={pendingCount > 0 ? '#F0ECFF' : '#F5F5F5'}
          stroke={pendingCount > 0 ? '#D6CCFF' : '#E5E5E5'}
          strokeWidth={1}
        >
          <Text fontSize={11} fontWeight="bold" fill={pendingCount > 0 ? '#7B61FF' : '#666666'}>
            {roomCode}
          </Text>
        </AutoLayout>
      </AutoLayout>

      {/* Subtext reflecting live state */}
      <Text fontSize={12} fill="#757575">
        {pendingCount > 0
          ? `${pendingCount} capture${pendingCount > 1 ? 's' : ''} waiting on room ${roomCode}.`
          : `Pair extension with code ${roomCode} to collect references.`}
      </Text>

      {/* Dynamic Action Button */}
      <AutoLayout
        padding={{ vertical: 10, horizontal: 14 }}
        cornerRadius={6}
        fill="#7B61FF"
        hoverStyle={{ fill: '#6949FF' }}
        horizontalAlignItems="center"
        verticalAlignItems="center"
        width="fill-parent"
        onClick={openCollector}
      >
        <Text fontSize={13} fontWeight="bold" fill="#FFFFFF">
          {pendingCount > 0 ? `⚡ Drop ${pendingCount} Images` : 'Open FigDrop'}
        </Text>
      </AutoLayout>
    </AutoLayout>
  );
}

widget.register(FigDropWidget);
