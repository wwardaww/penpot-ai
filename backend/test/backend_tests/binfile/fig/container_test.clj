;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.binfile.fig.container-test
  (:require
   [app.binfile.fig.container :as container]
   [app.binfile.fig.geom :as geom]
   [backend-tests.binfile.fig.fixtures :as fx]
   [clojure.java.io :as jio]
   [clojure.test :as t]))

(defn- validation-code [f]
  (try (f) nil
       (catch clojure.lang.ExceptionInfo cause
         (let [data (ex-data cause)]
           (when (= :validation (:type data)) (:code data))))))

(def ^:private small-message
  {:type :NODE_CHANGES
   :nodeChanges [(fx/node {:id [0 0] :type :DOCUMENT :name "Document"})]})

(t/deftest chunk-compression-is-detected
  (let [data (.getBytes "some payload some payload" "UTF-8")]
    (t/is (= :zstd (container/compression (fx/zstd data))))
    (t/is (= :zlib (container/compression (fx/zlib data))))
    (t/is (= :deflate (container/compression (fx/deflate-raw data))))
    (doseq [f [fx/zstd fx/zlib fx/deflate-raw]]
      (t/is (= (vec data) (vec (container/decompress (f data) 1000)))))))

(t/deftest decompression-is-bounded
  (let [data (byte-array 100000)]
    (t/is (= :fig-file-too-large
             (validation-code #(container/decompress (fx/zstd data) 1000))))))

(t/deftest a-bare-canvas-is-read
  (doseq [[schema-c message-c] [[fx/deflate-raw fx/zstd]
                                [fx/zlib fx/deflate-raw]
                                [fx/zstd fx/zlib]]]
    (let [path (fx/temp-file ".fig")]
      (with-open [out (jio/output-stream path)]
        (.write out ^bytes (fx/canvas small-message :compress-schema schema-c
                                      :compress-message message-c :version 70)))
      (let [doc (container/read-file path)]
        (t/is (= "fig-kiwi" (:prelude doc)))
        (t/is (= 70 (:version doc)))
        (t/is (= :DOCUMENT (get-in doc [:message :nodeChanges 0 :type])))
        (t/is (= {} (:images doc)))))))

(t/deftest a-saved-file-is-read-with-its-images
  (let [png  fx/tiny-png
        hash (fx/sha1-hex png)
        path (fx/write-zip! (fx/temp-file ".fig") (fx/canvas small-message)
                            :images {hash png})
        doc  (container/read-file path)]
    (t/is (= "Fixture" (get-in doc [:meta :file_name])))
    (t/is (= [hash] (keys (:images doc))))
    (t/is (= "image/png" (container/image-mtype (get (:images doc) hash))))))

(t/deftest bad-files-fail-with-a-validation-error
  (t/testing "not a figma file"
    (let [path (fx/temp-file ".fig")]
      (spit path "hello, this is not a figma file")
      (t/is (= :invalid-fig-file (validation-code #(container/read-file path))))))
  (t/testing "a zip without canvas.fig"
    (let [path (fx/temp-file ".fig")]
      (with-open [zip (java.util.zip.ZipOutputStream. (jio/output-stream path))]
        (.putNextEntry zip (java.util.zip.ZipEntry. "other.txt"))
        (.write zip (.getBytes "x"))
        (.closeEntry zip))
      (t/is (= :invalid-fig-file (validation-code #(container/read-file path))))))
  (t/testing "a FigJam file"
    (let [path (fx/temp-file ".fig")]
      (with-open [out (jio/output-stream path)]
        (.write out ^bytes (fx/canvas small-message :prelude "fig-jam.")))
      (t/is (= :unsupported-fig-kind (validation-code #(container/read-file path))))))
  (t/testing "a corrupted chunk"
    (let [path  (fx/temp-file ".fig")
          bytes (fx/canvas small-message)]
      ;; overwrite the start of the schema chunk with garbage
      (doseq [i (range 16 24)] (aset-byte bytes i (byte 0x7f)))
      (with-open [out (jio/output-stream path)]
        (.write out ^bytes bytes))
      (t/is (some? (validation-code #(container/read-file path)))))))

(t/deftest command-blobs-become-path-segments
  (let [blob (fx/commands-blob [[1 0 0] [2 10 0] [3 10 10 0 10] [4 0 5 0 5 0 0] [0]])
        segs (geom/decode-commands blob (geom/from-fig (fx/at 100 200)))]
    (t/is (= [:move-to :line-to :curve-to :curve-to :close-path] (mapv :command segs)))
    (t/is (= {:x 100.0 :y 200.0} (:params (first segs))))
    (t/is (= {:x 110.0 :y 200.0} (:params (second segs))))
    (t/testing "a quadratic curve becomes the equivalent cubic"
      (let [{:keys [x y c1x c1y c2x c2y]} (:params (nth segs 2))]
        (t/is (= [100.0 210.0] [x y]))
        (t/is (< (Math/abs (- c1x 110.0)) 1e-9))
        (t/is (< (Math/abs (- c1y (+ 200.0 (* 2/3 10.0)))) 1e-9))
        (t/is (< (Math/abs (- c2x (+ 100.0 (* 2/3 10.0)))) 1e-9))
        (t/is (< (Math/abs (- c2y 210.0)) 1e-9))))))

(t/deftest vector-networks-keep-open-segments-open
  (let [blob (fx/network-blob [[0 0] [10 0] [10 10]] [[0 1] [1 2] [2 0]] [[1 [[0 1 2]]]])
        net  (geom/decode-vector-network blob)
        segs (geom/network->segments net geom/identity-matrix)]
    (t/is (= :nonzero (get-in net [:regions 0 :winding])))
    (t/is (= [:move-to :line-to :line-to :line-to :close-path] (mapv :command segs))))
  (let [blob (fx/network-blob [[0 0] [20 0]] [[0 1]] [])
        segs (geom/network->segments (geom/decode-vector-network blob) geom/identity-matrix)]
    (t/is (= [:move-to :line-to] (mapv :command segs)))))

(t/deftest transforms-compose
  (let [parent (geom/from-fig (fx/at 10 20))
        child  (geom/from-fig (fx/rotated 90 5 0))
        abs    (geom/multiply parent child)
        [x y]  (geom/apply-point abs [1 0])]
    (t/is (< (Math/abs (- x 15.0)) 1e-9))
    (t/is (< (Math/abs (- y 21.0)) 1e-9))
    (t/is (< (Math/abs (- 90.0 (geom/rotation abs))) 1e-9))))
