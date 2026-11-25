;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.frame-grid-test
  "Which frames the viewport draws a layout grid for."
  (:require
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [app.main.ui.workspace.viewport.frame-grid :as frame-grid]
   [cljs.test :as t :include-macros true]))

(defn- frame
  [grids]
  {:id (uuid/next) :type :frame :parent-id uuid/zero :frame-id uuid/zero :grids grids})

(t/deftest grid-frames-are-the-frames-that-display-a-grid
  (let [shown   (frame [{:type :square :display true}])
        hidden  (frame [{:type :square :display false}])
        plain   (frame nil)
        rect    {:id (uuid/next) :type :rect :parent-id (:id shown) :frame-id (:id shown)}
        objects (into {uuid/zero {:id uuid/zero :type :frame}}
                      (map (juxt :id identity))
                      [shown hidden plain rect])]
    (t/is (= [(:id shown)] (mapv :id (frame-grid/get-grid-frames objects))))
    (t/testing "a page index left by an earlier commit gives the same frames"
      (t/is (= [(:id shown)]
               (mapv :id (frame-grid/get-grid-frames (ctst/update-page-index objects))))))))
