import { v4 as uuid } from 'uuid';
import { findKey, includes, groupBy } from 'lodash';
import {
  getEntityAttributes,
  createDataElement,
  getGraphMLTypeForKey,
  getAttributePropertyFromCodebook,
  formatXml,
} from './helpers';
import { VariableType } from '../../utils/protocol-consts';
import {
  entityAttributesProperty,
  entityPrimaryKeyProperty,
  caseProperty,
  sessionProperty,
  remoteProtocolProperty,
  sessionExportTimeProperty,
  sessionFinishTimeProperty,
  sessionStartTimeProperty,
  protocolName,
  exportIDProperty,
  egoProperty,
  ncSourceUUID,
  ncTargetUUID,
  edgeSourceProperty,
  edgeTargetProperty,
  ncTypeProperty,
  ncUUIDProperty,
} from '../../utils/reservedAttributes';

const jsSHA = require('jssha/dist/sha1');

// In a browser process, window provides a globalContext;
// in an electron main process, we can inject required globals
let globalContext;

/* eslint-disable no-undef, global-require */
if (typeof window !== 'undefined' && window.DOMParser && window.XMLSerializer) {
  globalContext = window;
} else {
  const dom = require('xmldom');
  globalContext = {};
  globalContext.DOMParser = dom.DOMParser;
  globalContext.XMLSerializer = dom.XMLSerializer;
}
/* eslint-enable */

const eol = '\n';

// Create a serializer for reuse below.
const serializer = new globalContext.XMLSerializer();
const serialize = fragment => `${serializer.serializeToString(fragment)}${eol}`;

// Utility function for indenting and serializing XML element
const formatAndSerialize = element => {
  return formatXml(serialize(element));
}

// Utility sha1 function that returns hashed text
const sha1 = (text) => {
  const shaInstance = new jsSHA("SHA-1", "TEXT", { encoding: "UTF8" });
  shaInstance.update(text);
  return shaInstance.getHash("HEX");
}

// If includeNCMeta is true, include our custom XML schema
const getXmlHeader = () => {
    return `<?xml version="1.0" encoding="UTF-8"?>
  <graphml
    xmlns="http://graphml.graphdrawing.org/xmlns"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns
    http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd"
    xmlns:nc="http://schema.networkcanvas.com/xmlns">${eol}`;
}

// Use exportOptions.defaultOptions from FileExportManager to determine parameters
// for edge direction.
const getGraphHeader = ({ globalOptions: { useDirectedEdges, } }, sessionVariables) => {
  const edgeDefault = useDirectedEdges ? 'directed' : 'undirected';

  let metaAttributes = `nc:caseId="${sessionVariables[caseProperty]}"
  nc:sessionUUID="${sessionVariables[sessionProperty]}"
  nc:protocolName="${sessionVariables[protocolName]}"
  nc:remoteProtocolID="${sessionVariables[remoteProtocolProperty]}"
  nc:sessionExportTime="${sessionVariables[sessionExportTimeProperty]}"`;

  if (sessionVariables[sessionStartTimeProperty]) {
    metaAttributes += `${eol}    nc:sessionStartTime="${sessionVariables[sessionStartTimeProperty]}"`;
  }

  if (sessionVariables[sessionFinishTimeProperty]) {
    metaAttributes += `${eol}    nc:sessionFinishTime="${sessionVariables[sessionFinishTimeProperty]}"`;
  }
  return `<graph
  edgedefault="${edgeDefault}"
  ${metaAttributes}
>${eol}`;
};

const getGraphFooter = `</graph>${eol}`

const xmlFooter = `</graphml>${eol}`;

// Use exportOptions from FileExportManager to determine XML properties
const setUpXml = (exportOptions, sessionVariables) => {
  const graphMLOutline = `${getXmlHeader()}${getGraphHeader(exportOptions, sessionVariables)}${xmlFooter}`;
  return (new globalContext.DOMParser()).parseFromString(graphMLOutline, 'text/xml');
};

// <key> elements provide the type definitions for GraphML data elements
// @return {Object} a fragment to insert
//                  codebook: `{ fragment: <DocumentFragment> }`.
const generateKeyElements = (
  document, // the XML ownerDocument
  entities, // network.nodes or edges, or ego
  type, // 'node' or 'edge' or 'ego'
  excludeList, // Variables to exlcude
  codebook, // codebook
) => {
  let fragment = '';

  // Create an array to track variables we have already created <key>s for
  const done = [];

  /**
   * REMOVED LAYOUT KEY CREATION:
   * We used to create a Gephi readable layout <key> here, but
   * it has been removed because (1) Gephi is unstable and presently not well
   * maintained, and (2) its implementation is nonstandard.
   */

  // Create <key> for a 'label' variable allowed on all elements.
  // This is used by gephi to label nodes/edges.
  // Only create once!
  if (type === 'node' && done.indexOf('label') === -1 && !excludeList.includes('label')) {

    const labelDataElement = document.createElement('key');
    labelDataElement.setAttribute('id', 'label');
    labelDataElement.setAttribute('attr.name', 'label');
    labelDataElement.setAttribute('attr.type', 'string');
    labelDataElement.setAttribute('for', 'all');
    fragment += `${serialize(labelDataElement)}`;
    done.push('label');
  }

  // Create a <key> for the network canvas entity type.
  if (type === 'node' && done.indexOf('type') === -1 && !excludeList.includes('type')) {
    // Create <key> for type
    const typeDataElement = document.createElement('key');
    typeDataElement.setAttribute('id', ncTypeProperty);
    typeDataElement.setAttribute('attr.name', ncTypeProperty);
    typeDataElement.setAttribute('attr.type', 'string');
    typeDataElement.setAttribute('for', 'all');
    fragment += `${serialize(typeDataElement)}`;
    done.push('type');
  }

  // Create a <key> for network canvas UUID.
  if (type === 'node' && done.indexOf('uuid') === -1 && !excludeList.includes('uuid')) {
    // Create <key> for type
    const typeDataElement = document.createElement('key');
    typeDataElement.setAttribute('id', ncUUIDProperty);
    typeDataElement.setAttribute('attr.name', ncUUIDProperty);
    typeDataElement.setAttribute('attr.type', 'string');
    typeDataElement.setAttribute('for', 'all');
    fragment += `${serialize(typeDataElement)}`;
    done.push('uuid');
  }

  // Create a <key> for from and to properties that reference network canvas UUIDs.
  if (type === 'edge' && done.indexOf('originalEdgeSource') === -1) {
    // Create <key> for type
    const typeDataElement = document.createElement('key');
    typeDataElement.setAttribute('id', ncTargetUUID);
    typeDataElement.setAttribute('attr.name', ncTargetUUID);
    typeDataElement.setAttribute('attr.type', 'string');
    typeDataElement.setAttribute('for', 'edge');
    fragment += `${serialize(typeDataElement)}`;

    const typeDataElement2 = document.createElement('key');
    typeDataElement2.setAttribute('id', ncSourceUUID);
    typeDataElement2.setAttribute('attr.name', ncSourceUUID);
    typeDataElement2.setAttribute('attr.type', 'string');
    typeDataElement2.setAttribute('for', 'edge');
    fragment += `${serialize(typeDataElement2)}`;

    done.push('originalEdgeSource');
  }

  // Main loop over entities
  entities.forEach((element) => {
    const elementAttributes = getEntityAttributes(element);
    let keyTarget = type === 'ego' ? 'graph' : type; // nodes and edges set for="node|edge" but ego has for="graph"

    // Loop over attributes
    Object.keys(elementAttributes).forEach((key) => {
      // transpose ids to names based on codebook; fall back to the raw key
      let keyName = getAttributePropertyFromCodebook(codebook, type, element, key, 'name') || key;


      // Test if we have already created a key for this variable, and that it
      // isn't on our exclude list.
      if (done.indexOf(key) === -1 && !excludeList.includes(keyName)) {
        const keyElement = document.createElement('key');

        // Determine attribute type to decide how to encode
        const variableType = getAttributePropertyFromCodebook(codebook, type, element, key);

        // <key> id must be xs:NMTOKEN: http://books.xmlschemata.org/relaxng/ch19-77231.html
        // do not be tempted to change this to the variable 'name' for this reason!
        // If variableType is undefined, variable wasn't in the codebook (could be external data).
        // This means that key might not be a UUID, so update the key ID to be SHA1 of variable
        // name to ensure it is xs:NMTOKEN compliant
        if (variableType) {
          keyElement.setAttribute('id', key);
        } else {
          const hashedKeyName = sha1(key);
          keyElement.setAttribute('id', hashedKeyName);
        }

        // Use human readable variable name for the attr.name attribute
        keyElement.setAttribute('attr.name', keyName);

        switch (variableType) {
          case VariableType.boolean:
            keyElement.setAttribute('attr.type', variableType);
            break;
          case VariableType.ordinal:
          case VariableType.number: {
            const keyType = getGraphMLTypeForKey(entities, key);
            keyElement.setAttribute('attr.type', keyType || 'string');
            break;
          }
          case VariableType.layout: {
            // special handling for layout variables: split the variable into
            //two <key> elements - one for X and one for Y.
            keyElement.setAttribute('attr.name', `${keyName}_Y`);
            keyElement.setAttribute('id', `${key}_Y`);
            keyElement.setAttribute('attr.type', 'double');

            // Create a second element to model the <key> for
            // the X value
            const keyElement2 = document.createElement('key');
            keyElement2.setAttribute('id', `${key}_X`);
            keyElement2.setAttribute('attr.name', `${keyName}_X`);
            keyElement2.setAttribute('attr.type', 'double');
            keyElement2.setAttribute('for', keyTarget);
            fragment += `${serialize(keyElement2)}`;
            break;
          }
          case VariableType.categorical: {
            /**
             * Special handling for categorical variables:
             * Because categorical variables can have multiple membership, we
             * split them out into several boolean variables
             *
             * Because key id must be an xs:NMTOKEN, we hash the option value.
             */

            // fetch options property for this variable
            const options = getAttributePropertyFromCodebook(codebook, type, element, key, 'options');

            options.forEach((option, index) => {
              const hashedOptionValue = sha1(option.value);

              if (index === options.length - 1) {
                keyElement.setAttribute('id', `${key}_${hashedOptionValue}`);
                keyElement.setAttribute('attr.name', `${keyName}_${option.value}`);
                keyElement.setAttribute('attr.type', 'boolean');
              } else {
                const keyElement2 = document.createElement('key');
                keyElement2.setAttribute('id', `${key}_${hashedOptionValue}`);
                keyElement2.setAttribute('attr.name', `${keyName}_${option.value}`);
                keyElement2.setAttribute('attr.type', 'boolean');
                keyElement2.setAttribute('for', keyTarget);
                fragment += `${serialize(keyElement2)}`;
              }
            });
            break;
          }
          case VariableType.scalar:
            keyElement.setAttribute('attr.type', 'float');
            break;
          case VariableType.text:
          case VariableType.datetime:
          default:
            keyElement.setAttribute('attr.type', 'string');
        }

        keyElement.setAttribute('for', keyTarget);
        fragment += `${serialize(keyElement)}`;
        done.push(key);
      }
    });
  });
  return fragment;
};

const generateEgoDataElements = (
  document, // the XML ownerDocument
  ego, // List of nodes or edges or an object representing ego
  excludeList, // Attributes to exclude lookup of in codebook
  codebook, // Copy of codebook
  exportOptions, // Export options object
) => {
  let fragment = '';

  /**
   * Ego is a special case
   * Ego data elements are attached directly to the <graph> element
   */
  // Get the ego's attributes for looping over later
  const entityAttributes = getEntityAttributes(ego);

  // Create data element for Ego UUID
  fragment += formatAndSerialize(createDataElement(document, { key: ncUUIDProperty }, ego[entityPrimaryKeyProperty]));


  // Add entity attributes
  Object.keys(entityAttributes).forEach((key) => {
    const keyName = getAttributePropertyFromCodebook(codebook, 'ego', null, key, 'name');
    const keyType = getAttributePropertyFromCodebook(codebook, 'ego', null, key, 'type');

    // Generate sha1 of keyname if it wasn't found in the codebook
    if (!keyName) {
      keyName = sha1(key);
    }


    if (!excludeList.includes(keyName) && !!entityAttributes[key]) {
      if (keyType === 'categorical') {
        const options = getAttributePropertyFromCodebook(codebook, 'ego', null, key, 'options');
        options.forEach((option) => {
          const hashedOptionValue = sha1(option.value);
          const optionKey = `${key}_${hashedOptionValue}`;
          fragment += formatAndSerialize(createDataElement(
            document, { key: optionKey }, !!entityAttributes[key] && includes(entityAttributes[key], option.value),
          ));
        });
      } else if (keyType && typeof entityAttributes[key] !== 'object') {
        fragment += formatAndSerialize(createDataElement(document, { key }, entityAttributes[key]));
      } else if (keyType === 'layout') {
        // Determine if we should use the normalized or the "screen space" value
        let xCoord;
        let yCoord;
        if (exportOptions.globalOptions.useScreenLayoutCoordinates) {
          xCoord = (entityAttributes[key].x * exportOptions.globalOptions.screenLayoutWidth).toFixed(2);
          yCoord = ((1.0 - entityAttributes[key].y) * exportOptions.globalOptions.screenLayoutHeight).toFixed(2);
        } else {
          xCoord = entityAttributes[key].x;
          yCoord = entityAttributes[key].y;
        }

        fragment += formatAndSerialize(createDataElement(document, { key: `${key}_X` }, xCoord));
        fragment += formatAndSerialize(createDataElement(document, { key: `${key}_Y` }, yCoord));

      } else {
        fragment += formatAndSerialize(
          createDataElement(document, { key: keyName }, entityAttributes[key]),
        );
      }
    }
  });

  return fragment;
}

// @return {DocumentFragment} a fragment containing all XML elements for the supplied dataList
const generateDataElements = (
  document, // the XML ownerDocument
  entities, // List of nodes or edges or an object representing ego
  type, // Element type to be created. "node" or "egde"
  excludeList, // Attributes to exclude lookup of in codebook
  codebook, // Copy of codebook
  exportOptions, // Export options object
) => {
  let fragment = '';

  // Iterate entities
  entities.forEach((entity) => {
    // Create an element representing the entity (<node> or <edge>)
    const domElement = document.createElement(type);

    // Get the entity's attributes for looping over later
    const entityAttributes = getEntityAttributes(entity);

    // Set the id of the entity element to the export ID property,
    // or generate a new UUID if needed
    if (entity[entityPrimaryKeyProperty]) {
      domElement.setAttribute('id', entity[exportIDProperty]);
    } else {
      console.warn('no export ID found on entity. Generating random UUID...');
      domElement.setAttribute('id', uuid());
    }

    // Create data element for entity UUID
    domElement.appendChild(createDataElement(document, { key: ncUUIDProperty }, entity[entityPrimaryKeyProperty]));

    // Create data element for entity type
    const entityTypeName = codebook[type][entity.type].name || entity.type;
    domElement.appendChild(createDataElement(document, { key: ncTypeProperty }, entityTypeName));

    // Special handling for model variables and variables unique to entity type
    if (type === 'edge') {
      // Add source and target properties and map
      // them to the _from and _to attributes
      domElement.setAttribute('source', entity[edgeSourceProperty]);
      domElement.setAttribute('target', entity[edgeTargetProperty]);

      // Insert the nc UUID versions of 'to' and 'from' under special properties
      domElement.appendChild(createDataElement(document, { key: ncSourceUUID }, entity[ncSourceUUID]));
      domElement.appendChild(createDataElement(document, { key: ncTargetUUID }, entity[ncTargetUUID]));
    } else {
      // For nodes, add <data> for label
      // If there is no name property, fall back to labelling as "Node"
      const entityLabel = () => {
        const variableCalledName = findKey(codebook[type][entity.type].variables, variable => variable.name.toLowerCase() === 'name');

        if (variableCalledName && entity[entityAttributesProperty][variableCalledName]) {
          return entity[entityAttributesProperty][variableCalledName];
        }

        return "Node"
      }

      domElement.appendChild(createDataElement(document, { key: 'label' }, entityLabel()));
    }

    // Add entity attributes
    Object.keys(entityAttributes).forEach((key) => {
      let keyName = getAttributePropertyFromCodebook(codebook, type, entity, key, 'name');
      const keyType = getAttributePropertyFromCodebook(codebook, type, entity, key, 'type');

      // Generate sha1 of keyname if it wasn't found in the codebook
      if (!keyName) {
        keyName = sha1(key);
      }


      if (!excludeList.includes(keyName) && !!entityAttributes[key]) {
        // Handle categorical variables
        if (keyType === 'categorical') {
          const options = getAttributePropertyFromCodebook(codebook, type, entity, key, 'options');
          options.forEach((option) => {
            const hashedOptionValue = sha1(option.value);
            const optionKey = `${key}_${hashedOptionValue}`;
            domElement.appendChild(createDataElement(
              document, { key: optionKey }, !!entityAttributes[key] && includes(entityAttributes[key], option.value),
            ));
          });
        // Handle all codebook variables apart from layout variables
        } else if (keyType && typeof entityAttributes[key] !== 'object') {
          domElement.appendChild(createDataElement(document, { key }, entityAttributes[key]));
        // Handle layout variables
        } else if (keyType === 'layout') {
          // Determine if we should use the normalized or the "screen space" value
          let xCoord;
          let yCoord;
          if (exportOptions.globalOptions.useScreenLayoutCoordinates) {
            xCoord = (entityAttributes[key].x * exportOptions.globalOptions.screenLayoutWidth).toFixed(2);
            yCoord = ((1.0 - entityAttributes[key].y) * exportOptions.globalOptions.screenLayoutHeight).toFixed(2);
          } else {
            xCoord = entityAttributes[key].x;
            yCoord = entityAttributes[key].y;
          }

          domElement.appendChild(createDataElement(document, { key: `${key}_X` }, xCoord));
          domElement.appendChild(createDataElement(document, { key: `${key}_Y` }, yCoord));

        // Handle non-codebook variables
        } else {
          // If we reach this point, we could not detect the attribute type by looking in the codebook.
          // We assume it is not in the codebook, and therefore use the SHA1 hash of the name as the key
          domElement.appendChild(
            createDataElement(document, { key: keyName }, entityAttributes[key]),
          );
        }
      }
    });

    fragment += `${formatAndSerialize(domElement)}`;
  });

  return fragment;
};

/**
 * Generator function to supply XML content in chunks to both string and stream producers
 * @param {*} network
 * @param {*} codebook
 * @param {*} exportOptions
 */
export function* graphMLGenerator(network, codebook, exportOptions) {
  yield getXmlHeader();

  const xmlDoc = setUpXml(exportOptions, network.sessionVariables);

  const generateEgoKeys = ego => generateKeyElements(
    xmlDoc,
    [ego], // TODO: refactor key generation function to not need collection.
    'ego',
    [],
    codebook,
  );

  const generateNodeKeys = nodes => generateKeyElements(
    xmlDoc,
    nodes,
    'node',
    [],
    codebook,
  );

  const generateEdgeKeys = edges => generateKeyElements(
    xmlDoc,
    edges,
    'edge',
    [],
    codebook,
  );
  const generateNodeElements = nodes => generateDataElements(
    xmlDoc,
    nodes,
    'node',
    [],
    codebook,
    exportOptions,
  );

  const generateEdgeElements = edges => generateDataElements(
    xmlDoc,
    edges,
    'edge',
    [],
    codebook,
    exportOptions,
  );

  const generateEgoElements = ego => generateEgoDataElements(
    xmlDoc,
    ego,
    [],
    codebook,
    exportOptions,
  );

  // generate keys for ego
  if (exportOptions.globalOptions.unifyNetworks) {
    const combinedEgos = Object.values(network.ego).reduce((union, ego) => {
      return { [entityAttributesProperty]: { ...union[entityAttributesProperty], ...ego[entityAttributesProperty] } };
    }, { [entityAttributesProperty]: {} });
    yield generateEgoKeys(combinedEgos);
  } else {
    yield generateEgoKeys(network.ego);
  }

  // generate keys for nodes
  yield generateNodeKeys(network.nodes);

  // generate keys for edges
  yield generateEdgeKeys(network.edges);

  if (exportOptions.globalOptions.unifyNetworks) {
    // Group nodes and edges by sessionProperty, and then map.
    network.nodes = groupBy(network.nodes, sessionProperty);
    network.edges = groupBy(network.edges, sessionProperty);

    for (let sessionID in network.sessionVariables) {
      yield getGraphHeader(exportOptions, network.sessionVariables[sessionID]);

      // Add ego to graph
      if (network.ego[sessionID]) {
        yield generateEgoElements(network.ego[sessionID]);
      }

      // add nodes and edges to graph
      if (network.nodes[sessionID]) {
        for (let i = 0; i < network.nodes[sessionID].length; i += 100) {
          yield generateNodeElements(network.nodes[sessionID].slice(i, i + 100));
        }
      }

      if (network.edges[sessionID]) {
        for (let i = 0; i < network.edges[sessionID].length; i += 100) {
          yield generateEdgeElements(network.edges[sessionID].slice(i, i + 100));
        }
      }

      yield getGraphFooter;
    }


  } else {
    // TODO: reduce duplication with this code
    yield getGraphHeader(exportOptions, network.sessionVariables);

    // Add ego to graph
    if (network.ego) {
      yield generateEgoElements(network.ego);
    }

    // add nodes and edges to graph
    if (network.nodes) {
      for (let i = 0; i < network.nodes.length; i += 100) {
        yield generateNodeElements(network.nodes.slice(i, i + 100));
      }
    }

    if (network.edges) {
      for (let i = 0; i < network.edges.length; i += 100) {
        yield generateEdgeElements(network.edges.slice(i, i + 100));
      }
    }

    yield getGraphFooter;
  }

  yield xmlFooter;
}
