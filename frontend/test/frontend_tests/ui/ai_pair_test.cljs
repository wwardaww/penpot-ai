;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-pair-test
  "Penforge pair route (W11): after storing the token, the tab goes back
  only to the Penpot page that linked to it, never out of Penpot."
  (:require
   [app.main.ui.workspace.ai.chat.pair :as pair]
   [cljs.test :as t :include-macros true]))

(def ^:private origin "https://localhost:3449")

(t/deftest goes-back-to-a-penpot-page
  (t/is (true? (pair/came-from-penpot? (str origin "/?screen=workspace") origin 3)))
  (t/is (true? (pair/came-from-penpot? origin origin 2))))

(t/deftest stays-without-a-penpot-referrer
  (t/testing "typed, pasted or opened from the daemon console"
    (t/is (false? (pair/came-from-penpot? "" origin 2)))
    (t/is (false? (pair/came-from-penpot? nil origin 2))))
  (t/testing "another site, or a host that only starts like this origin"
    (t/is (false? (pair/came-from-penpot? "https://evil.example/" origin 2)))
    (t/is (false? (pair/came-from-penpot? "https://localhost:34490/" origin 2))))
  (t/testing "nothing to go back to"
    (t/is (false? (pair/came-from-penpot? (str origin "/") origin 1)))))
