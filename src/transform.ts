import * as Path from "path";
import * as ts from "typescript";
import * as tjs from "@marionebl/typescript-json-schema";
import * as readPkgUp from "read-pkg-up";
import * as JSON5 from "json5";
import * as resolveFrom from "resolve-from";

export interface TransformerOptions {
  env: { [key: string]: string };
}

const SOURCES = new Set(["from-type.ts", "from-type.d.ts"]);

export const getTransformer = (program: ts.Program) => {
  const typeChecker = program.getTypeChecker();

  function getVisitor(ctx: ts.TransformationContext, sf: ts.SourceFile) {
    const visitor: ts.Visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (ts.isCallExpression(node)) {
        if (typeof node.typeArguments === 'undefined' || node.typeArguments.length === 0) {
          return node;
        }

        const signature = typeChecker.getResolvedSignature(node);

        if (
          signature !== undefined &&
          signature.declaration !== undefined
        ) {
          const sourceName = signature.declaration.getSourceFile().fileName;

          if (!SOURCES.has(Path.basename(sourceName))) {
            return ts.visitEachChild(node, visitor, ctx);
          }

          const pkg = readPkgUp.sync({ cwd: Path.dirname(sourceName) }).pkg || {
            name: ""
          };

          if (pkg.name !== "ts-transform-json-schema") {
            return ts.visitEachChild(node, visitor, ctx);
          }

          const typeArgument = node.typeArguments[0];

          const type = typeChecker.getTypeFromTypeNode(typeArgument);
          const symbol = (type.symbol || type.aliasSymbol);

          const argNode = node.arguments[0];
          const options = argNode ? getOptions(argNode) : {};

          if (typeof symbol === 'undefined' || symbol === null) {
            throw new Error(`Could not find symbol for passed type`);
          }

          return toLiteral(tjs.generateSchema(program as unknown as tjs.Program, symbol.name, options as tjs.PartialArgs));
        }
      }
      
      const dirName = Path.dirname(node.getSourceFile().fileName);

      if (
        ts.isImportDeclaration(node)
      ) {
        const target = require.resolve('./from-type');
        const rawSpec = node.moduleSpecifier.getText();
        const spec = rawSpec.substring(1, rawSpec.length - 1);

        if (resolveFrom.silent(dirName, spec) === target) {
          return;
        }
      }

      return ts.visitEachChild(node, visitor, ctx);
    };

    return visitor;
  }

  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => (
    sf: ts.SourceFile
  ) => ts.visitNode(sf, getVisitor(ctx, sf));
};

// TODO: Factor out, test
function toLiteral(input: unknown): ts.PrimaryExpression {
  if (
    typeof input === "string" ||
    typeof input === "boolean" ||
    typeof input === "number"
  ) {
    return ts.createLiteral(input);
  }

  if (typeof input === "object" && Array.isArray(input)) {
    return ts.createArrayLiteral(input.map(toLiteral));
  }

  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const ob = input as object;
    return ts.createObjectLiteral(
      Object.keys(ob).map(key =>
        ts.createPropertyAssignment(
          ts.createLiteral(key),
          toLiteral(ob[key])
        )
      )
    );
  }

  return ts.createNull();
}

function getOptions(node: ts.Node): unknown {
  try {
    return JSON5.parse(node.getText())
  } catch (err) {
    return;
  }
}