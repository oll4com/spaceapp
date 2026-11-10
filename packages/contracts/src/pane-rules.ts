/** Business rule shared by the pane update and the Room Agent's room:layout action: a pane is never maximized and minimized at once (ARCH-002). */
export const maximizedAndMinimized = (pane: { isMaximized?: boolean; isMinimized?: boolean }) =>
  pane.isMaximized === true && pane.isMinimized === true;
