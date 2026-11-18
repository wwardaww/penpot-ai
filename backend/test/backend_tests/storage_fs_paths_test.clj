;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.storage-fs-paths-test
  "The fs storage keeps an absolute directory as it is (the desktop app
  points it at the user's app data folder, a drive letter path on
  Windows) and resolves a relative one against the working directory."
  (:require
   [app.storage.fs :as sfs]
   [app.storage.tmp :as tmp]
   [clojure.test :as t]
   [datoteka.fs :as fs]
   [integrant.core :as ig]))

(t/deftest absolute-paths-stay-absolute
  (let [base (str (fs/path (System/getProperty "java.io.tmpdir") "penforge-assets"))]
    (t/is (= (str (.normalize (fs/path base)))
             (str (sfs/normalize-path (str base "/a/../b/.."))))))
  (t/is (= (str (fs/path (str fs/*cwd*) "assets"))
           (str (sfs/normalize-path "assets")))))

(t/deftest backend-keeps-an-absolute-directory
  (let [dir     (str (fs/path (System/getProperty "java.io.tmpdir") "penforge-assets"))
        backend (ig/init-key ::sfs/backend {::sfs/directory dir})]
    (t/is (= (str (.normalize (fs/path dir))) (::sfs/directory backend)))
    (t/is (= "file" (:scheme (::sfs/uri backend))))))

(t/deftest create-dir-makes-the-parents
  (let [base (fs/path (System/getProperty "java.io.tmpdir") (str "penforge-" (random-uuid)))
        dir  (fs/path base "a" "b")]
    (try
      (tmp/create-dir! dir)
      (t/is (fs/exists? dir))
      (tmp/create-dir! dir)
      (t/is (fs/exists? dir) "an existing folder is fine")
      (finally
        (fs/delete base)))))
