;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.activity.overlay
  "Canvas effect while the AI works (W25).

  While the AI may change the design (a chat turn streams or a workflow
  runs, see `app.main.data.ai.chat/busy?`), the edges of the visible
  canvas glow and one \"AI\" badge shows. Both fade out when the work
  ends.

  The effect belongs to the canvas, not to its shapes: it is plain HTML
  in screen space and reads nothing but the chat, so its cost does not
  depend on the number of shapes, and zoom, pan and commits never render
  it again. Only opacity is animated.

  Mounted in the viewports of both renderers (SVG and render-wasm),
  between the design and the viewport controls; it stays off the rulers
  and never takes pointer events. With `prefers-reduced-motion` it stays
  still."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.ai.chat :as chat]
   [app.main.store :as st]
   [app.main.ui.workspace.viewport.rulers :as rulers]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def fade-out-ms
  "How long the effect takes to disappear after the work ends."
  700)

;; derived from the chat alone, so the other state changes (thousands
;; during an AI script) do not run the check below
(def ^:private ref:chat
  (l/derived #(get-in % [:penforge :chat]) st/state identical?))

(def ^:private ref:busy
  (l/derived chat/busy? ref:chat))

(mf/defc ai-activity*
  "Glow along the edges of the canvas while the AI works. Props:
  `show-rulers`, whether the rulers cover the top and left edges."
  {::mf/wrap [mf/memo]}
  [{:keys [show-rulers]}]
  (let [busy   (mf/deref ref:busy)
        shown* (mf/use-state busy)
        shown  (deref shown*)
        strip  (if ^boolean show-rulers rulers/ruler-area-size 0)]

    (mf/with-effect [busy]
      (if busy
        (reset! shown* true)
        (let [timer (js/setTimeout #(reset! shown* false) fade-out-ms)]
          #(js/clearTimeout timer))))

    (when (or busy shown)
      [:div {:class (stl/css-case :activity true
                                  :leaving (not busy))
             :style #js {:inset (dm/str strip "px 0 0 " strip "px")}
             :aria-hidden true
             :data-testid "ai-activity"}
       [:span {:class (stl/css :edge :edge-top)}]
       [:span {:class (stl/css :edge :edge-right)}]
       [:span {:class (stl/css :edge :edge-bottom)}]
       [:span {:class (stl/css :edge :edge-left)}]
       [:span {:class (stl/css :badge)
               :data-testid "ai-activity-badge"}
        [:svg {:class (stl/css :sparkle) :view-box "5 3 14 14"}
         [:path {:d "M12 4l1.4 4.6L18 10l-4.6 1.4L12 16l-1.4-4.6L6 10l4.6-1.4z"}]]
        (tr "penforge.activity.badge")]])))
