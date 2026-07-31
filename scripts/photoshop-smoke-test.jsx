#target photoshop

(function () {
  var outputFile = new File("E:/tool/ozon_sjsq/dist/ps-compare/ps-automation-ok.txt");
  outputFile.parent.create();
  outputFile.encoding = "UTF8";
  outputFile.open("w");
  outputFile.write("ok " + new Date().toISOString());
  outputFile.close();
})();
