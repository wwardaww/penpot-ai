;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.device-screens
  "Adds device screen boards (`app.main.devices`) to the current page,
  right of the shapes already there, as one undo step."
  (:require
   [app.common.data :as d]
   [app.common.files.changes-builder :as pcb]
   [app.common.files.helpers :as cfh]
   [app.common.files.shapes-helpers :as cfsh]
   [app.common.geom.shapes :as gsh]
   [app.common.math :as mth]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.data.event :as ev]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.devices :as devices]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def board-gap
  "Space between new boards, and between them and the shapes already
  on the page."
  100)

(defn state-label
  "The translated label of a device state."
  [state]
  (case state
    :portrait     (tr "penforge.devices.state.portrait")
    :landscape    (tr "penforge.devices.state.landscape")
    :folded       (tr "penforge.devices.state.folded")
    :unfolded     (tr "penforge.devices.state.unfolded")
    :cover        (tr "penforge.devices.state.cover")
    :left-screen  (tr "penforge.devices.state.left-screen")
    :right-screen (tr "penforge.devices.state.right-screen")
    :spanned      (tr "penforge.devices.state.spanned")
    (name state)))

(defn boards-origin
  "Top-left point for a row of boards of `specs` sizes. Right of
  `occupied` (the rect of the page's top-level shapes, nil on an empty
  page), top aligned with it; on an empty page the row is centered on
  `center` (or placed at the origin without one)."
  [occupied center specs]
  (if (some? occupied)
    {:x (+ (:x occupied) (:width occupied) board-gap)
     :y (:y occupied)}
    (let [row-width  (+ (reduce + (map :width specs))
                        (* board-gap (max 0 (dec (count specs)))))
          row-height (reduce max 0 (map :height specs))
          cx         (:x center 0)
          cy         (:y center 0)]
      (if (some? center)
        {:x (mth/round (- cx (/ row-width 2)))
         :y (mth/round (- cy (/ row-height 2)))}
        {:x 0 :y 0}))))

(defn layout-boards
  "Board shapes for `specs`, laid out left to right from `origin`, at
  the root of the page."
  [specs origin]
  (loop [specs  specs
         x      (:x origin)
         boards []]
    (if-let [{:keys [name width height]} (first specs)]
      (recur (rest specs)
             (+ x width board-gap)
             (conj boards
                   (cts/setup-shape {:type :frame
                                     :id (uuid/next)
                                     :name name
                                     :x x
                                     :y (:y origin)
                                     :width width
                                     :height height
                                     :parent-id uuid/zero
                                     :frame-id uuid/zero})))
      boards)))

(defn- occupied-rect
  [objects]
  (let [roots (cfh/get-immediate-children objects)]
    (when (seq roots)
      (gsh/shapes->rect roots))))

(defn add-device-boards
  "Adds the boards of the catalog device `device-id` to the current
  page in one commit, selects them and brings them into view. With
  `with-states`, a device with states (tablet, foldable or dual
  screen) gets one board per state instead of one."
  [device-id {:keys [with-states]}]
  (ptk/reify ::add-device-boards
    ptk/WatchEvent
    (watch [it state _]
      (if-let [device (devices/get-device device-id)]
        (let [page-id (:current-page-id state)
              objects (dsh/lookup-page-objects state page-id)
              specs   (devices/board-specs device with-states state-label)
              origin  (boards-origin (occupied-rect objects)
                                     (dsh/get-viewport-center state)
                                     specs)
              boards  (layout-boards specs origin)
              changes (reduce (fn [changes board]
                                (second (cfsh/prepare-add-shape changes board objects)))
                              (-> (pcb/empty-changes it page-id)
                                  (pcb/with-objects objects))
                              boards)
              ids     (into (d/ordered-set) (map :id) boards)]
          (rx/of (dch/commit-changes changes)
                 (dws/select-shapes ids)
                 (when (get-in state [:workspace-local :vport])
                   (dwz/fit-to-shapes ids))
                 (ev/event {::ev/name "add-device-boards"
                            ::ev/origin "workspace:device-screens"
                            :device (name device-id)
                            :boards (count boards)})))
        (rx/empty)))))
