// Test-only AST selection of the exact dormant production branch. Unlike a
// duplicated function or SDK mock, this fails closed when the declaration moves.
const ts = require("typescript");
module.exports = function selectLegacy(source) {
  const file = ts.createSourceFile(this.resourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = 0;
  const statements = file.statements.flatMap(statement => {
    if (!ts.isFunctionDeclaration(statement)) return [statement];
    if (statement.name?.text === "roomAgentSupervisorWorkflow") return [];
    if (statement.name?.text !== "legacyRoomAgentSupervisorWorkflow") return [statement];
    found++;
    return [ts.factory.updateFunctionDeclaration(statement,
      [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword), ...(statement.modifiers || [])],
      statement.asteriskToken, ts.factory.createIdentifier("roomAgentSupervisorWorkflow"),
      statement.typeParameters, statement.parameters, statement.type, statement.body)];
  });
  if (found !== 1) throw new Error(`Expected one legacy supervisor declaration, found ${found}`);
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file, statements));
};
