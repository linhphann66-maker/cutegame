/**
 * Cổng khu chung — cơ chế liền mạch kiểu bản web gốc.
 *
 * KHÔNG di chuyển nhân vật. Chỉ theo dõi vị trí và cập nhật trạng thái khi
 * người chơi tự đi bộ qua ranh giới vườn (bán kính 18m):
 * - Trong vườn -> ngoài vườn: ra khu chung
 * - Ngoài vườn -> trong vườn: về nhà riêng
 * - Đang thăm nhà người khác + ra ngoài: kết thúc thăm, ở lại khu chung
 *
 * Hoạt động cả offline (tự track, không phụ thuộc online).
 */
import type { GameBridge } from './game-bridge.ts';

const GARDEN_RADIUS = 18;

// null = chưa khởi tạo, true = trong vườn, false = ngoài vườn (khu chung)
let wasInside: boolean | null = null;
let visitingRef: () => string | null = () => null;

export function initCommonGates(game: GameBridge, getVisiting: () => string | null) {
  visitingRef = getVisiting;
  game.onFrame(() => {
    const presence = game.getPresence();
    if (presence.planet !== 'home') { wasInside = null; return; }

    const r = Math.hypot(presence.x, presence.z);
    const isInside = r < GARDEN_RADIUS;
    const visiting = visitingRef();

    if (wasInside === null) {
      wasInside = isInside;
      return;
    }
    if (wasInside === isInside) return; // chưa qua ranh giới

    // Vừa đi qua ranh giới vườn
    if (wasInside && !isInside) {
      // Trong -> ngoài: ra khu chung
      if (visiting) {
        // Đang thăm nhà người khác: kết thúc thăm, ở lại vị trí hiện tại (khu chung)
        endVisitStayHere(game);
      } else {
        game.enterCommon?.();
      }
    } else if (!wasInside && isInside) {
      // Ngoài -> trong: về nhà riêng
      game.exitCommon?.();
    }
    wasInside = isInside;
  });
}

/**
 * Kết thúc thăm nhà nhưng giữ người chơi ở vị trí hiện tại (khu chung),
 * thay vì bị đưa về nhà mình như mặc định.
 */
function endVisitStayHere(game: GameBridge) {
  const world = game.getWorld() as unknown as { position: { x: number; z: number } };
  const px = world.position.x, pz = world.position.z;
  const name = visitingRef();
  // Visit online thật: báo server, server trả lời rồi tự setVisiting(null).
  // Visit nhà AI (offline): leaveVisitToCommon() trả false (không socket) → tự dọn ở local.
  const handledOnline = game.leaveVisitToCommon?.() ?? false;
  if (!handledOnline) {
    if (game.leaveBotVisit) game.leaveBotVisit();
    else game.setVisiting(null);
    if (name) game.showNotice(`👋 Đã rời nhà của ${name}. Vào cổng lần nữa là về nhà của bạn.`);
  }
  // Giữ nguyên vị trí (đề phòng setVisiting reset vị trí)
  world.position.x = px;
  world.position.z = pz;
}
