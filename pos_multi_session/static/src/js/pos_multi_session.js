openerp.pos_multi_session = function(instance){
    var module = instance.point_of_sale;
    var _t = instance.web._t;

    module.OrderWidget.include({
        rerender_orderline: function(order_line){
            if (order_line.node)
                return this._super(order_line);
        }
    })
    module.ReceiptScreenWidget = module.ReceiptScreenWidget.extend({
        finishOrder: function() {
            this.pos.get('selectedOrder').destroy({'reason': 'finishOrder'});
        }
    })

    var PosModelSuper = module.PosModel;
    module.PosModel = module.PosModel.extend({
        initialize: function(){
            var self = this;
            PosModelSuper.prototype.initialize.apply(this, arguments)
            this.multi_session = false;
            this.ready = this.ready.then(function(){
                             if (self.config.multi_session_id){
                                 self.multi_session = new module.MultiSession(self);
                                 return self.multi_session.start();
                             }
                         });
            this.ms_syncing_in_progress = false;
            this.ms_update_timeout = false;
            this.get('orders').bind('remove', function(order,_unused_,options){ 
                order.ms_remove_order();
            });

        },
        on_removed_order: function(removed_order,index,reason){
            if (this.multi_session){
                if (reason === 'finishOrder'){
                    if (this.get('orders').size() > 0){
                        return this.set({'selectedOrder' : this.get('orders').at(index) || this.get('orders').first()});
                    }
                    this.add_new_order();
                    this.get('selectedOrder').ms_replace_empty_order = true;
                    return;
                }
            }
            var self = this;
            return PosModelSuper.prototype.on_removed_order.apply(this, arguments)
        },

        ms_on_update: function(message){
            this.ms_syncing_in_progress = true;
            console.log('on_update', message)
            var action = message.action;
            var data = message.data
            var order = false;
            if (data.uid){
                order = this.get('orders').find(function(order){
                    return order.uid == data.uid;
                })
            }
            if (order && action == 'remove_order'){
                order.destroy({'reason': 'abandon'})
            } else if (action == 'update') {
                this.ms_do_update(order, data);
            } else if (action == 'sync_sequence_number'){
                this.ms_do_sync_sequence_number(data);
            }
            this.ms_syncing_in_progress = false;
        },
        ms_on_add_order: function(current_order){
            if (current_order && current_order.ms_replace_empty_order && current_order.is_empty()){
                //replace order
                current_order.destroy({'reason': 'abandon'})
            }else{
                // keep current_order active
                this.set('selectedOrder', current_order);
            }
        },
        ms_create_order: function(){
            return new module.Order({pos: this});
        },
        ms_do_sync_sequence_number: function(data){
            if (data.sequence_number < this.pos_session.sequence_number){
                // another pos has obsolete sequence_number
                this.multi_session.sync_sequence_number(this.pos_session.sequence_number);
            } else {
                // update sequence_number (value for next number)
                this.pos_session.sequence_number = data.sequence_number;
            }
            /*
            this.get('orders').each(function(r){
                var sn = data[r.uid];
                if (sn != r.sequence_number){
                    r.sequence_number = sn;
                }
            })
             */
        },
        ms_do_update: function(order, data){
            var pos = this;
            var sequence_number = data.sequence_number;
            if (!order){
                if (sequence_number == this.pos_session.sequence_number){
                    //ok
                } else if (sequence_number > this.pos_session.sequence_number){
                    // this pos has obsolete sequence_number
                    this.pos_session.sequence_number = sequence_number;
                } else if (sequence_number < this.pos_session.sequence_number){
                    // another pos has obsolete sequence_number
                    pos.multi_session.sync_sequence_number();
                }
                order = this.ms_create_order()
                order.uid = data.uid;
                order.sequence_number = data.sequence_number
                var current_order = this.get_order();
                this.get('orders').add(order);
                this.ms_on_add_order(current_order);
            }
            var not_found = order.get('orderLines').map(function(r){
                                return r.uid;
                            })
            _.each(data.lines, function(dline){
                dline = dline[2];
                var line = order.get('orderLines').find(function(r){
                    return dline.uid == r.uid
                })
                not_found = _.without(not_found, dline.uid);
                var product = pos.db.get_product_by_id(dline.product_id);
                if (!line){
                    line = new module.Orderline({}, {pos: pos, order: order, product: product});
                    line.uid = dline.uid
                }
                if(dline.qty !== undefined){
                    line.set_quantity(dline.qty);
                }
                if(dline.price_unit !== undefined){
                    line.set_unit_price(dline.price_unit);
                }
                if(dline.discount !== undefined){
                    line.set_discount(dline.discount);
                }
                order.get('orderLines').add(line)
            })

            _.each(not_found, function(uid){
                var line = order.get('orderLines').find(function(r){
                               return uid == r.uid;
                           })
                order.get('orderLines').remove(line);
            })

        }
    })

    var is_first_order = true;
    var OrderSuper = module.Order;
    module.Order = module.Order.extend({
        initialize: function(){
            var self = this;
            OrderSuper.prototype.initialize.apply(this, arguments);
            this.ms_replace_empty_order = is_first_order;
            is_first_order = false;
            this.bind('change:sync', function(){
                self.ms_update();
            })
        },
        removeOrderline: function(line){
            OrderSuper.prototype.removeOrderline.apply(this, arguments);
            line.order.trigger('change:sync');
        },
        ms_check: function(){
            if (! this.pos.multi_session )
                return;
            if (this.pos.ms_syncing_in_progress)
                return;
            return true;
        },
        ms_update: function(){
            var self = this;
            if (!this.ms_check())
                return;
            if (this.pos.ms_update_timeout)
                // restart timeout
                clearTimeout(this.pos.ms_update_timeout)
            this.pos.ms_update_timeout = setTimeout(
                function(){
                    self.pos.ms_update_timeout = false;
                    self.do_ms_update();
                }, 300)
        },
        ms_remove_order: function(){
            if (!this.ms_check())
                return;
            this.do_ms_remove_order();
        },
        do_ms_remove_order: function(){
            this.pos.multi_session.remove_order({'uid': this.uid});
        },
        do_ms_update: function(){
            var data = this.export_as_JSON();
            this.pos.multi_session.update(data);
        }
    })
    var OrderlineSuper = module.Orderline;
    module.Orderline = module.Orderline.extend({
        initialize: function(){
            var self = this;
            OrderlineSuper.prototype.initialize.apply(this, arguments);
            this.bind('change', function(line){
                line.order.trigger('change:sync')
            })
            this.uid = this.order.generateUniqueId() + '-' + this.id;
        },
        export_as_JSON: function(){
            var data = OrderlineSuper.prototype.export_as_JSON.apply(this, arguments);
            data.uid = this.uid;
            return data;
        }
    })

    module.MultiSession = Backbone.Model.extend({
        initialize: function(pos){
            this.pos = pos;
        },
        start: function(){
            var self = this;
            //var  done = new $.Deferred();

            this.bus = instance.bus.bus;
            this.bus.on("notification", this, this.on_notification);
            this.bus.start_polling();

            //return done;
        },
        sync_sequence_number: function(){
            var orders = {};
            this.pos.get('orders').each(function(r){
                orders[r.uid] = r.sequence_number;
            })
            var data = {
                'sequence_number': this.pos.pos_session.sequence_number,
                //'orders': orders,
            }
            this.send({action: 'sync_sequence_number', data: data})
        },
        remove_order: function(data){
            this.send({action: 'remove_order', data: data})
        },
        update: function(data){
            this.send({action: 'update', data: data})
        },
        send: function(message){
            console.log('send', message)
           var self = this;
            var send_it = function() {
                return openerp.session.rpc("/pos_multi_session/update", {multi_session_id: self.pos.config.multi_session_id[0], message: message});
            };
            var tries = 0;
            send_it().fail(function(error, e) {
                e.preventDefault();
                tries += 1;
                if (tries < 3)
                    return send_it();
            });
        },
        on_notification: function(notification) {
            var self = this;
            var channel = notification[0];
            var message = notification[1];

            if(Array.isArray(channel) && channel[1] === 'pos.multi_session'){
                this.pos.ms_on_update(message)
            }
        }
    })
}